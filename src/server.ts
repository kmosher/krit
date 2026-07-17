import { readFile } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { getGitDiff, getCustomGitDiff, getRepoName, getBranchName, getFileContent, getFileContentAtRef, getRepoRoot, resolveDiffRefs, WORKING_TREE_REF, getUntrackedFilePaths, writeWorkingTreeFile } from './git.js'
import { loadSettings, saveSettings } from './settings.js'
import { InMemoryCommentStore } from './comments.js'
import type { CommentStore } from './comments.js'
import { isSafePath } from './path.js'
import { watchRepo, type RepoWatcher } from './watcher.js'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

export interface BinaryFileInfo {
  path: string
  type: 'added' | 'deleted' | 'changed' | 'untracked'
}

function parseFilePaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/)
    if (match) paths.add(match[1])
  }
  return [...paths]
}

// Slice a single file's fragment out of a multi-file unified patch, for
// GET /api/diff?file=. Each file's fragment runs from its `diff --git` line
// up to (but not including) the next one. Returns '' if the path has no
// pending diff (e.g. it was reverted between the fs-watcher event firing and
// this request landing) — the caller treats that as "nothing to show."
function extractFilePatch(patch: string, filePath: string): string {
  const lines = patch.split('\n')
  const targetPrefix = `diff --git a/`
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(targetPrefix)) continue
    const match = lines[i].match(/^diff --git a\/.+ b\/(.+)$/)
    if (start === -1) {
      if (match?.[1] === filePath) start = i
      continue
    }
    // Found the start already; this is the next file's header — stop here.
    end = i
    break
  }
  if (start === -1) return ''
  return lines.slice(start, end).join('\n')
}

function parseBinaryFiles(patch: string, untrackedFiles?: Set<string>): BinaryFileInfo[] {
  const binaryFiles: BinaryFileInfo[] = []
  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('Binary files ') || !line.includes(' differ')) continue

    // Find the file path from the preceding diff --git line
    let filePath = ''
    for (let j = i - 1; j >= 0; j--) {
      const match = lines[j].match(/^diff --git a\/.+ b\/(.+)$/)
      if (match) {
        filePath = match[1]
        break
      }
    }
    if (!filePath) continue

    // Determine change type from surrounding lines
    let changeType: BinaryFileInfo['type'] = 'changed'
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j].startsWith('diff --git')) break
      if (lines[j].startsWith('new file mode')) {
        changeType = 'added'
        break
      }
      if (lines[j].startsWith('deleted file mode')) {
        changeType = 'deleted'
        break
      }
    }

    if (changeType === 'added' && untrackedFiles?.has(filePath)) {
      changeType = 'untracked'
    }
    binaryFiles.push({ path: filePath, type: changeType })
  }
  return binaryFiles
}

type SubscriberRole = 'ui' | 'cli'
interface Subscriber {
  id: string
  role: SubscriberRole
  stream: SSEStreamingApi
}

export function createApp(
  clientDir: string,
  customDiffArgs?: string[],
  commentStore?: CommentStore,
  onSubscriberCountChange?: (count: number) => void,
) {
  const app = new Hono()
  const isCustomMode = !!customDiffArgs
  const store = commentStore ?? new InMemoryCommentStore()
  const viewedFiles = new Set<string>()

  const subscribers = new Set<Subscriber>()
  const snapshotState = () => ({
    watcherCount: [...subscribers].filter((s) => s.role === 'cli').length,
    uiCount: [...subscribers].filter((s) => s.role === 'ui').length,
  })
  const sendTo = async (sub: Subscriber, payload: unknown) => {
    try {
      await sub.stream.writeSSE({ data: JSON.stringify(payload) })
    } catch {
      if (subscribers.delete(sub)) onSubscriberCountChange?.(subscribers.size)
    }
  }
  const broadcast = async (payload: unknown) => {
    await Promise.all([...subscribers].map((s) => sendTo(s, payload)))
  }
  const broadcastState = () => broadcast({ type: 'state', ...snapshotState() })

  // Always-on fs-watcher: catches changes made outside the in-browser editor
  // (an agent's own Edit tool, `git checkout`, a build step) without relying
  // on the agent to remember to call `diffx refresh`. Content-hashed and
  // debounced in watchRepo() so it stays quiet on mtime-only churn.
  const repoWatcher: RepoWatcher = watchRepo(getRepoRoot(), (path) => {
    void broadcast({ type: 'file-changed', path })
  })

  // Bundle both file sides into /api/diff so CodeView can render with full
  // metadata (isPartial:false) and enable hunk-context expansion. Files over
  // the per-file cap return as { oversize: true, size } without contents —
  // CodeView falls back to patch-only rendering for those.
  const FILE_TEXT_CAP_BYTES = 5 * 1024 * 1024
  app.get('/api/diff', (c) => {
    let patch: string
    const staged = c.req.query('staged') === 'true'
    const untracked = c.req.query('untracked') === 'true'
    let refs: { baseRef: string; headRef: string }
    if (isCustomMode) {
      patch = getCustomGitDiff(customDiffArgs)
      refs = resolveDiffRefs(customDiffArgs)
    } else {
      patch = getGitDiff({ staged, untracked })
      // Refs must mirror what getGitDiff actually covers so parseDiffFromFile
      // can reproduce the patch from the bundled file contents:
      //   - staged=true alone        → index vs HEAD          → {HEAD, INDEX}
      //   - staged=true + untracked  → working tree vs HEAD   → {HEAD, WORKING_TREE}
      //   - staged=false (default)   → working tree vs index  → {INDEX, WORKING_TREE}
      // The previous ternary always used {HEAD, INDEX} when staged=true, which
      // produced empty file contents when nothing was staged — making CodeView
      // render headers with no bodies (no hunks).
      if (staged && untracked) {
        refs = { baseRef: 'HEAD', headRef: WORKING_TREE_REF }
      } else if (staged) {
        refs = { baseRef: 'HEAD', headRef: 'INDEX' }
      } else {
        refs = { baseRef: 'INDEX', headRef: WORKING_TREE_REF }
      }
    }
    const repoName = getRepoName()
    const branch = getBranchName()
    const untrackedFiles = untracked ? getUntrackedFilePaths() : []
    const untrackedSet = new Set(untrackedFiles)
    const binaryFiles = parseBinaryFiles(patch, untrackedSet)
    const filePaths = parseFilePaths(patch)
    const binarySet = new Set(binaryFiles.map((b) => b.path))

    type SideContents =
      | { contents: string }
      | { binary: true }
      | { oversize: true; size: number }
      | { missing: true }
    const readSide = (path: string, ref: string): SideContents => {
      const buf = getFileContentAtRef(path, ref)
      if (!buf) return { missing: true }
      // Binary sniff: NUL byte in first 8KB. Matches git's own heuristic.
      const sniff = Math.min(buf.length, 8192)
      for (let i = 0; i < sniff; i++) {
        if (buf[i] === 0) return { binary: true }
      }
      if (buf.length > FILE_TEXT_CAP_BYTES) {
        return { oversize: true, size: buf.length }
      }
      return { contents: buf.toString('utf-8') }
    }

    // ?file=<path> scopes the response to one file — used for targeted
    // refetches (fs-watcher / file-written events carry a path) so a change
    // to one file doesn't require re-fetching and re-parsing the whole diff.
    const fileFilter = c.req.query('file')
    if (fileFilter) {
      const fragment = extractFilePatch(patch, fileFilter)
      return c.json({
        patch: fragment,
        repoName,
        branch,
        customMode: isCustomMode,
        binaryFiles: binaryFiles.filter((b) => b.path === fileFilter),
        untrackedFiles: untrackedFiles.filter((f) => f === fileFilter),
        fileContents: binarySet.has(fileFilter)
          ? {}
          : { [fileFilter]: { old: readSide(fileFilter, refs.baseRef), new: readSide(fileFilter, refs.headRef) } },
      })
    }

    const fileContents: Record<string, { old: SideContents; new: SideContents }> = {}
    for (const path of filePaths) {
      // Binary files render via BinaryFileDiff (outside CodeView); skip.
      if (binarySet.has(path)) continue
      fileContents[path] = {
        old: readSide(path, refs.baseRef),
        new: readSide(path, refs.headRef),
      }
    }

    return c.json({
      patch,
      repoName,
      branch,
      customMode: isCustomMode,
      binaryFiles,
      untrackedFiles,
      fileContents,
    })
  })

  app.get('/api/file-content', (c) => {
    const path = c.req.query('path')
    const version = c.req.query('version') as 'old' | 'new'
    if (!path || !version) {
      return c.json({ error: 'Missing path or version' }, 400)
    }
    const content = getFileContent(path, version)
    if (!content) {
      return c.json({ error: 'File not found' }, 404)
    }
    const ext = extname(path)
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    return new Response(new Uint8Array(content), {
      headers: { 'Content-Type': contentType },
    })
  })

  app.put('/api/file-content', async (c) => {
    // Write file contents back to the working tree. Used by in-browser edit
    // mode — the agent picks up the change on its next diff poll.
    const { path, contents } = await c.req.json()
    if (typeof path !== 'string' || typeof contents !== 'string') {
      return c.json({ error: 'path and contents required' }, 400)
    }
    if (!writeWorkingTreeFile(path, contents)) {
      return c.json({ error: 'write failed (unsafe path or IO error)' }, 400)
    }
    // Force watchers to refetch the diff so the edit appears immediately.
    void broadcast({ type: 'file-written', path })
    return c.json({ ok: true })
  })

  app.post('/api/refresh', async (c) => {
    // Manual nudge for changes made outside the in-browser editor (e.g. an
    // agent editing files on disk via its own tools) — those writes don't go
    // through PUT /api/file-content, so nothing else broadcasts file-written.
    void broadcast({ type: 'file-written', path: null })
    return c.json({ ok: true })
  })

  app.get('/api/settings', (c) => {
    return c.json(loadSettings())
  })

  app.put('/api/settings', async (c) => {
    const body = await c.req.json()
    const settings = saveSettings(body)
    return c.json(settings)
  })

  app.get('/api/viewed', (c) => {
    return c.json([...viewedFiles])
  })

  app.put('/api/viewed', async (c) => {
    const { filePath, viewed } = await c.req.json<{ filePath: string; viewed: boolean }>()
    if (viewed) {
      viewedFiles.add(filePath)
    } else {
      viewedFiles.delete(filePath)
    }
    return c.json({ ok: true })
  })

  app.get('/api/comments', async (c) => {
    const comments = await store.getAll()
    return c.json(comments)
  })

  app.post('/api/comments', async (c) => {
    const body = await c.req.json()
    // Clamp endLine to never precede lineNumber. Inverted ranges from a buggy client
    // would otherwise silently store and confuse every downstream consumer.
    const lineNumber: number = body.lineNumber
    const endLine: number = Math.max(body.endLine ?? lineNumber, lineNumber)
    // Pass through suggestion if shaped correctly. We validate just enough to
     // avoid persisting garbage from a misbehaving client; full schema validation
     // lives in the type system, not the wire.
    const rawSuggestion = body.suggestion
    const suggestion =
      rawSuggestion &&
      Array.isArray(rawSuggestion.newLines) &&
      rawSuggestion.newLines.every((x: unknown) => typeof x === 'string')
        ? { newLines: rawSuggestion.newLines as string[] }
        : undefined
    const comment = {
      id: crypto.randomUUID(),
      filePath: body.filePath,
      side: body.side,
      lineNumber,
      endLine,
      lineContent: body.lineContent,
      body: body.body,
      status: 'open' as const,
      createdAt: Date.now(),
      replies: [],
      ...(suggestion ? { suggestion } : {}),
    }
    const created = await store.add(comment)
    void broadcast({ type: 'comment-added', comment: created })
    return c.json(created, 201)
  })

  app.put('/api/comments/:id', async (c) => {
    const id = c.req.param('id')
    const { body, status } = await c.req.json()
    const updated = await store.update(id, { body, status })
    if (!updated) return c.json({ error: 'Comment not found' }, 404)
    return c.json(updated)
  })

  app.post('/api/comments/:id/replies', async (c) => {
    const commentId = c.req.param('id')
    // source=ui → human in the browser; anything else (including absent) → agent/CLI.
    // The browser must opt in explicitly. This makes the "safer" silent path the default
    // so an older or unknown client can't masquerade as a human, trigger auto-reopen,
    // and feed itself through the SSE watch loop.
    const source = c.req.query('source') === 'ui' ? 'ui' : 'cli'
    const { body } = await c.req.json()
    const replyAuthor: 'user' | 'agent' = source === 'ui' ? 'user' : 'agent'
    const reply = {
      id: crypto.randomUUID(),
      body,
      createdAt: Date.now(),
      author: replyAuthor,
    }
    const updated = await store.addReply(commentId, reply)
    if (!updated) return c.json({ error: 'Comment not found' }, 404)
    if (source === 'ui') {
      // A human reply on a resolved comment reopens it so the next agent pass picks it up.
      // The broadcast carries the post-update status so watchers don't have to re-GET to
      // notice the reopen — the wire event is the source of truth for state changes.
      if (updated.status === 'resolved') {
        await store.update(commentId, { status: 'open' })
        updated.status = 'open'
      }
      void broadcast({
        type: 'reply-added',
        commentId,
        reply,
        commentStatus: updated.status,
      })
    }
    return c.json(updated)
  })

  app.delete('/api/comments/:id', async (c) => {
    const id = c.req.param('id')
    const removed = await store.remove(id)
    if (!removed) return c.json({ error: 'Comment not found' }, 404)
    return c.json({ ok: true })
  })

  // SSE event stream. ?role=cli for `diffx watch` / `wait-for-submit`
  // watchers; default 'ui' for the browser. Event types on the wire:
  //   state          — subscriber-count snapshot (UI uses it to gate Submit)
  //   comment-added  — new comment from any source
  //   reply-added    — new reply from the UI (agent-posted replies suppressed
  //                    to avoid feeding the agent's own watch loop)
  //   submitted      — one-shot pulse when the user clicks "Done reviewing"
  app.get('/api/events', (c) => {
    const role: SubscriberRole = c.req.query('role') === 'cli' ? 'cli' : 'ui'
    return streamSSE(c, async (stream) => {
      const sub: Subscriber = { id: crypto.randomUUID(), role, stream }
      subscribers.add(sub)
      onSubscriberCountChange?.(subscribers.size)
      await broadcastState()
      // Initial snapshot to the new subscriber.
      await sendTo(sub, { type: 'state', ...snapshotState() })

      const cleanup = () => {
        if (subscribers.delete(sub)) {
          onSubscriberCountChange?.(subscribers.size)
          void broadcastState()
        }
      }
      c.req.raw.signal.addEventListener('abort', cleanup)

      // Hold open until the client (or the runtime) aborts. Periodic
      // comment pings keep proxies from idling the connection out.
      while (!stream.aborted) {
        await stream.sleep(30_000)
        if (stream.aborted) break
        try {
          await stream.writeSSE({ event: 'ping', data: '' })
        } catch {
          break
        }
      }
      cleanup()
    })
  })

  // Submit pulse: tells any waiting CLI watchers the human clicked Done
  // reviewing. This is NOT a session end — comments/replies keep flowing
  // over the same connection afterward. The server only shuts itself down
  // once every subscriber has actually disconnected (see IDLE_SHUTDOWN_MS
  // in startServer). Submit is idempotent on the wire; the UI is
  // responsible for greying out the button once the user has clicked it.
  app.post('/api/submit', async (c) => {
    const ts = Date.now()
    await broadcast({ type: 'submitted', timestamp: ts })
    return c.json({ ok: true, timestamp: ts })
  })

  app.get('/api/submit', (c) => c.json(snapshotState()))

  app.get('/*', async (c) => {
    let filePath = c.req.path
    if (filePath === '/') filePath = '/index.html'

    const relativePath = filePath.slice(1)
    if (!isSafePath(relativePath, clientDir)) {
      return c.text('Forbidden', 403)
    }
    const fullPath = resolve(clientDir, relativePath)
    try {
      const content = await readFile(fullPath)
      const ext = extname(fullPath)
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'
      return new Response(content, {
        headers: { 'Content-Type': contentType },
      })
    } catch {
      const indexContent = await readFile(join(clientDir, 'index.html'))
      return new Response(indexContent, {
        headers: { 'Content-Type': 'text/html' },
      })
    }
  })

  return { app, closeWatcher: () => repoWatcher.close() }
}

// Grace period after the last subscriber (browser tab or `diffx watch`)
// disconnects before the server shuts itself down. Long enough to survive a
// page refresh or a brief network blip without killing an in-progress review.
const IDLE_SHUTDOWN_MS = 60_000

export function startServer(options: {
  port: number
  host: string
  clientDir: string
  customDiffArgs?: string[]
}): Promise<{ port: number }> {
  let server: ReturnType<typeof serve>
  let idleTimer: NodeJS.Timeout | undefined
  // Don't arm the idle timer before anyone has ever connected — the window
  // between server start and the browser tab opening looks identical to
  // "everyone left" if we don't gate on this.
  let everHadSubscriber = false

  const onSubscriberCountChange = (count: number) => {
    if (count > 0) {
      everHadSubscriber = true
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
      return
    }
    if (!everHadSubscriber || idleTimer) return
    idleTimer = setTimeout(() => {
      void closeWatcher()
      server.close(() => process.exit(0))
    }, IDLE_SHUTDOWN_MS)
  }

  const { app, closeWatcher } = createApp(options.clientDir, options.customDiffArgs, undefined, onSubscriberCountChange)

  return new Promise((resolve) => {
    server = serve({
      fetch: app.fetch,
      port: options.port,
      hostname: options.host,
    }, (info) => {
      resolve({ port: info.port })
    })
  })
}
