import { readFile } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { streamSSE } from 'hono/streaming'
import { WebSocketServer } from 'ws'
import { getGitDiff, getCustomGitDiff, getRepoName, getBranchName, getFileContent, getFileContentAtRef, getRepoRoot, resolveDiffRefs, WORKING_TREE_REF, getUntrackedFilePaths, writeWorkingTreeFile } from './git.js'
import { loadSettings, saveSettings } from './settings.js'
import { InMemoryCommentStore, FileBackedCommentStore } from './comments.js'
import type { CommentStore } from './comments.js'
import { isSafePath } from './path.js'
import { watchRepo, type RepoWatcher } from './watcher.js'
import { reanchorFileComments } from './reanchor.js'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

// 'agent' subscribers connect over /api/events-ws (native WebSocket, see
// startServer) instead of SSE — the Claude skill's Monitor tool wires up
// directly to that instead of shelling out to `diffx watch`. Transport
// details live behind `send()` below so broadcast/sendTo don't care which
// kind of subscriber they're talking to.
type SubscriberRole = 'ui' | 'cli' | 'agent'
interface Subscriber {
  id: string
  role: SubscriberRole
  send(payload: unknown): Promise<void>
  // 'agent' only: mirrors the debounce `diffx watch` does client-side to
  // turn noisy `state` snapshots into a stable `clients {browsers}` line —
  // done server-side here since there's no separate CLI process to do it
  // on the agent's behalf for a native ws connection.
  clientsDebounce?: {
    timer?: NodeJS.Timeout
    lastEmitted: number
  }
}

// Debounce window for the state->clients transform, matching diffx watch's
// CLIENTS_DEBOUNCE_MS in subcommands.ts — long enough that a browser tab
// reload doesn't read as a leave-then-rejoin blip.
const CLIENTS_DEBOUNCE_MS = 4000

// Grace period after the last browser tab disconnects before the server
// shuts itself down. Long enough to survive a page refresh or a brief
// network blip without killing an in-progress review. Keyed on browser
// (role:'ui') presence specifically, not total subscriber count — a `diffx
// watch` or agent ws subscriber must never hold the server alive on its own,
// otherwise a long-lived watcher with no browser ever attached keeps the
// process running forever.
const IDLE_SHUTDOWN_MS = 60_000

// If no browser ever connects at all within this window of server start,
// nobody's reviewing — shut down instead of running forever. Distinct from
// IDLE_SHUTDOWN_MS, which only starts counting after a browser has been seen
// and then left.
const NO_BROWSER_TIMEOUT_MS = 3 * 60_000

export function createApp(
  clientDir: string,
  customDiffArgs?: string[],
  commentStore?: CommentStore,
  onShutdown?: () => void,
) {
  const app = new Hono()
  const isCustomMode = !!customDiffArgs
  const store = commentStore ?? new InMemoryCommentStore()
  const viewedFiles = new Set<string>()

  const subscribers = new Set<Subscriber>()
  const snapshotState = () => ({
    watcherCount: [...subscribers].filter((s) => s.role === 'cli').length,
    uiCount: [...subscribers].filter((s) => s.role === 'ui').length,
    agentCount: [...subscribers].filter((s) => s.role === 'agent').length,
  })
  const sendTo = async (sub: Subscriber, payload: unknown) => {
    // Agent (ws) subscribers get the same "clients" presence line
    // `diffx watch` derives client-side from `state` — never the raw
    // snapshot, which is noisier than an agent needs.
    if (sub.role === 'agent' && isRecord(payload) && payload.type === 'state' && typeof payload.uiCount === 'number') {
      scheduleClientsUpdate(sub, payload.uiCount)
      return
    }
    try {
      await sub.send(payload)
    } catch {
      if (subscribers.delete(sub)) checkIdle()
    }
  }
  const scheduleClientsUpdate = (sub: Subscriber, browsers: number) => {
    const debounce = (sub.clientsDebounce ??= { lastEmitted: -1 })
    if (debounce.timer) clearTimeout(debounce.timer)
    debounce.timer = setTimeout(() => {
      debounce.timer = undefined
      if (browsers === debounce.lastEmitted) return
      debounce.lastEmitted = browsers
      void sendTo(sub, { type: 'clients', browsers })
    }, CLIENTS_DEBOUNCE_MS)
  }
  const broadcast = async (payload: unknown) => {
    await Promise.all([...subscribers].map((s) => sendTo(s, payload)))
  }
  const broadcastState = () => broadcast({ type: 'state', ...snapshotState() })

  // Principal-based idle shutdown (see IDLE_SHUTDOWN_MS/NO_BROWSER_TIMEOUT_MS
  // above). `review-ended` is a terminal broadcast — `diffx watch` treats it
  // as "the reviewer left without submitting" (exit code 3) — sent before we
  // tear the process down so any connected watcher gets to see it land.
  let everHadBrowser = false
  let idleTimer: NodeJS.Timeout | undefined
  let noBrowserTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    void broadcast({ type: 'review-ended', reason: 'no-browser' }).then(() => onShutdown?.())
  }, NO_BROWSER_TIMEOUT_MS)
  const checkIdle = () => {
    const { uiCount } = snapshotState()
    if (uiCount > 0) {
      everHadBrowser = true
      if (noBrowserTimer) {
        clearTimeout(noBrowserTimer)
        noBrowserTimer = undefined
      }
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
      return
    }
    if (!everHadBrowser || idleTimer) return
    idleTimer = setTimeout(() => {
      void broadcast({ type: 'review-ended', reason: 'idle' }).then(() => onShutdown?.())
    }, IDLE_SHUTDOWN_MS)
  }

  const repoRoot = getRepoRoot()

  // Re-anchors non-resolved, additions-side comments on `path` to their new
  // position after a working-tree change and broadcasts the ones that moved
  // (or went outdated) as comment-updated — the UI, `diffx watch`, and any
  // ws agent subscriber all key off this event, so it runs server-side once
  // instead of three times with three chances to disagree. Drafts are
  // re-anchored (their position stays accurate) but never broadcast — they
  // stay invisible to every watcher until posted.
  const reanchorAndBroadcast = async (path: string) => {
    const changed = await reanchorFileComments(path, store, repoRoot)
    for (const comment of changed) {
      if (comment.status === 'draft') continue
      void broadcast({ type: 'comment-updated', comment })
    }
  }

  // Always-on fs-watcher: catches changes made outside the in-browser editor
  // (an agent's own Edit tool, `git checkout`, a build step) without relying
  // on the agent to remember to call `diffx refresh`. Content-hashed and
  // debounced in watchRepo() so it stays quiet on mtime-only churn.
  const repoWatcher: RepoWatcher = watchRepo(repoRoot, (path) => {
    void reanchorAndBroadcast(path).then(() => broadcast({ type: 'file-changed', path }))
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
    // Re-anchor before broadcasting file-written, so by the time watchers
    // refetch, comment positions already reflect the edit.
    await reanchorAndBroadcast(path)
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
    // Drafts are opt-in, not opt-out: the browser UI (which renders them
    // with a Draft badge) passes includeDrafts=true explicitly. Every other
    // caller — `diffx comments`, and anything else hitting this endpoint
    // without that flag — gets the agent-visible view, same as the
    // watcher/ws broadcast suppression. Without this, `diffx comments`
    // would leak drafts the reviewer hasn't posted yet.
    if (c.req.query('includeDrafts') === 'true') {
      return c.json(comments)
    }
    return c.json(comments.filter((comment) => comment.status !== 'draft'))
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
    // Only the UI is allowed to create a draft — status otherwise defaults
    // to 'open'. Anything else in the field is ignored rather than trusted,
    // same spirit as the suggestion validation above.
    const status: 'open' | 'draft' = body.status === 'draft' ? 'draft' : 'open'
    const comment = {
      id: crypto.randomUUID(),
      filePath: body.filePath,
      side: body.side,
      lineNumber,
      endLine,
      lineContent: body.lineContent,
      body: body.body,
      status,
      createdAt: Date.now(),
      replies: [],
      ...(suggestion ? { suggestion } : {}),
    }
    const created = await store.add(comment)
    // Drafts are invisible to the agent until posted — see postDraftsAndBroadcast.
    if (status !== 'draft') {
      void broadcast({ type: 'comment-added', comment: created })
    }
    return c.json(created, 201)
  })

  // Flips every draft comment to 'open' in one batch and broadcasts
  // comment-added for each — the moment they actually become visible to any
  // watcher/ws subscriber. Shared by the dedicated "Post drafts" button and
  // by /api/submit ("Done reviewing" shouldn't silently leave drafts behind).
  const postDraftsAndBroadcast = async () => {
    const all = await store.getAll()
    const drafts = all.filter((c) => c.status === 'draft')
    for (const draft of drafts) {
      const updated = await store.update(draft.id, { status: 'open' })
      if (updated) void broadcast({ type: 'comment-added', comment: updated })
    }
    return drafts.length
  }

  app.post('/api/drafts/post', async (c) => {
    const posted = await postDraftsAndBroadcast()
    return c.json({ ok: true, posted })
  })

  app.put('/api/comments/:id', async (c) => {
    const id = c.req.param('id')
    const { body, status } = await c.req.json()
    const wasDraft = status === undefined ? undefined : (await store.getAll()).find((c) => c.id === id)?.status === 'draft'
    const updated = await store.update(id, { body, status })
    if (!updated) return c.json({ error: 'Comment not found' }, 404)
    // A draft transitioning to open/resolved here (e.g. a one-off "post this
    // single draft" from the UI, distinct from the batch endpoint above)
    // needs the same comment-added catch-up broadcast, since it never got
    // one when it was first created as a draft.
    if (wasDraft && status !== 'draft') {
      void broadcast({ type: 'comment-added', comment: updated })
    }
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
  //   comment-added   — new comment from any source
  //   comment-updated — a comment was re-anchored after a live file edit
  //                     (see reanchor.ts), or its outdated flag flipped
  //   reply-added     — new reply from the UI (agent-posted replies suppressed
  //                     to avoid feeding the agent's own watch loop)
  //   file-changed    — fs-watcher detected an on-disk change outside the
  //                     in-browser editor
  //   file-written    — an explicit write (in-browser editor, or `diffx
  //                     refresh` with path:null for "everything")
  //   submitted       — one-shot pulse when the user clicks "Done reviewing"
  app.get('/api/events', (c) => {
    const role: SubscriberRole = c.req.query('role') === 'cli' ? 'cli' : 'ui'
    return streamSSE(c, async (stream) => {
      const sub: Subscriber = {
        id: crypto.randomUUID(),
        role,
        send: async (payload) => {
          await stream.writeSSE({ data: JSON.stringify(payload) })
        },
      }
      subscribers.add(sub)
      checkIdle()
      await broadcastState()
      // Initial snapshot to the new subscriber.
      await sendTo(sub, { type: 'state', ...snapshotState() })

      const cleanup = () => {
        if (subscribers.delete(sub)) {
          checkIdle()
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
  // once every browser tab has actually disconnected (see IDLE_SHUTDOWN_MS
  // above). Submit is idempotent on the wire; the UI is responsible for
  // greying out the button once the user has clicked it.
  app.post('/api/submit', async (c) => {
    // Done reviewing shouldn't silently leave drafts the reviewer forgot to
    // post stranded and invisible to the agent — post them first.
    await postDraftsAndBroadcast()
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

  // Registers a role:'agent' subscriber for the native /api/events-ws
  // endpoint (see startServer, which owns the raw WebSocket upgrade — that
  // needs Node's http.Server, which lives outside createApp's Hono-only
  // surface). Mirrors what the SSE handler above does on connect/disconnect
  // (idle-shutdown accounting, initial state snapshot) so an agent
  // connecting over ws behaves identically to one connecting over SSE.
  const registerAgentSubscriber = (send: (payload: unknown) => Promise<void>): (() => void) => {
    const sub: Subscriber = { id: crypto.randomUUID(), role: 'agent', send }
    subscribers.add(sub)
    checkIdle()
    void broadcastState()
    return () => {
      if (subscribers.delete(sub)) {
        checkIdle()
        void broadcastState()
      }
    }
  }

  return { app, closeWatcher: () => repoWatcher.close(), registerAgentSubscriber }
}

export function startServer(options: {
  port: number
  host: string
  clientDir: string
  customDiffArgs?: string[]
  // Comments (and drafts) persist here, next to the session state file, and
  // reload on start. Omitted -> in-memory only (matches prior behavior; also
  // what the test suite wants, since it doesn't want temp files on disk).
  commentsFilePath?: string
}): Promise<{ port: number }> {
  let server: ReturnType<typeof serve>

  // createApp owns the idle-shutdown decision (it needs uiCount, which only
  // it tracks); this is just the mechanics of actually tearing the process
  // down once createApp decides it's time.
  const onShutdown = () => {
    void closeWatcher()
    server.close(() => process.exit(0))
  }

  const commentStore = options.commentsFilePath ? new FileBackedCommentStore(options.commentsFilePath) : undefined
  const { app, closeWatcher, registerAgentSubscriber } = createApp(options.clientDir, options.customDiffArgs, commentStore, onShutdown)

  // Native WebSocket endpoint for an agent's Monitor connection — the
  // Claude skill wires Monitor's `ws:` source directly to this instead of
  // shelling out to `diffx watch`. noServer:true because we're sharing the
  // one HTTP server @hono/node-server already owns; WebSocketServer
  // normally wants to bind its own port. Handled at the raw http.Server
  // level (server.on('upgrade', ...)) since Hono itself has no upgrade
  // handling — @hono/node-server doesn't ship a /ws helper in the installed
  // version (1.19.12), and bumping it was out of scope for this change.
  const wss = new WebSocketServer({ noServer: true })

  return new Promise((resolve) => {
    server = serve({
      fetch: app.fetch,
      port: options.port,
      hostname: options.host,
    }, (info) => {
      resolve({ port: info.port })
    })

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== '/api/events-ws') {
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const unregister = registerAgentSubscriber(async (payload) => {
          await new Promise<void>((res, rej) => {
            ws.send(JSON.stringify(payload), (err) => (err ? rej(err) : res()))
          })
        })
        // Both can fire for the same disconnect (ws's own behavior); the
        // registration cleanup is idempotent (Set.delete no-ops the second
        // time), so calling unregister from both is safe.
        ws.on('close', unregister)
        ws.on('error', unregister)
      })
    })
  })
}
