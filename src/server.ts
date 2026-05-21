import { readFile } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { getGitDiff, getCustomGitDiff, getRepoName, getBranchName, getFileContent, getFileContentAtRef, resolveDiffRefs, WORKING_TREE_REF, isImageFile, getTabSizeForFiles, getUntrackedFilePaths } from './git.js'
import { loadSettings, saveSettings } from './settings.js'
import { InMemoryCommentStore } from './comments.js'
import type { CommentStore } from './comments.js'
import { isSafePath } from './path.js'

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

export function createApp(clientDir: string, customDiffArgs?: string[], commentStore?: CommentStore) {
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
      subscribers.delete(sub)
    }
  }
  const broadcast = async (payload: unknown) => {
    await Promise.all([...subscribers].map((s) => sendTo(s, payload)))
  }
  const broadcastState = () => broadcast({ type: 'state', ...snapshotState() })

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
      // Default mode mirrors how `git diff` behaves with no args: working tree vs HEAD,
      // unless --staged toggles index vs HEAD.
      refs = staged
        ? { baseRef: 'HEAD', headRef: 'INDEX' }
        : { baseRef: 'HEAD', headRef: WORKING_TREE_REF }
    }
    const repoName = getRepoName()
    const branch = getBranchName()
    const untrackedFiles = untracked ? getUntrackedFilePaths() : []
    const untrackedSet = new Set(untrackedFiles)
    const binaryFiles = parseBinaryFiles(patch, untrackedSet)
    const filePaths = parseFilePaths(patch)
    const tabSizeMap = getTabSizeForFiles(filePaths)
    return c.json({
      patch,
      repoName,
      branch,
      customMode: isCustomMode,
      binaryFiles,
      tabSizeMap,
      untrackedFiles,
      baseRef: refs.baseRef,
      headRef: refs.headRef,
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

  // Text variant of /api/file-content: returns JSON instead of raw bytes, so the
  // browser can pass it back to the diff renderer for hunk expansion. The `ref`
  // query is whatever resolveDiffRefs returned for this diff (a git rev, or one
  // of the WORKING_TREE / INDEX sentinels). Soft-caps payloads at FILE_TEXT_CAP_BYTES;
  // the client can re-request with ?force=true when the user explicitly opts in.
  const FILE_TEXT_CAP_BYTES = 5 * 1024 * 1024
  app.get('/api/file-text', (c) => {
    const path = c.req.query('path')
    const ref = c.req.query('ref')
    const force = c.req.query('force') === 'true'
    if (!path || !ref) {
      return c.json({ error: 'Missing path or ref' }, 400)
    }
    const content = getFileContentAtRef(path, ref)
    if (!content) {
      return c.json({ error: 'File not found' }, 404)
    }
    // Binary sniff: any NUL byte in the first 8KB. Cheaper than a magic-bytes table
    // and matches the same heuristic git uses for "diff: file is binary".
    const sniff = Math.min(content.length, 8192)
    for (let i = 0; i < sniff; i++) {
      if (content[i] === 0) {
        return c.json({ binary: true, size: content.length })
      }
    }
    if (content.length > FILE_TEXT_CAP_BYTES && !force) {
      return c.json({ oversize: true, size: content.length, cap: FILE_TEXT_CAP_BYTES })
    }
    return c.json({ contents: content.toString('utf-8'), size: content.length })
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
      await broadcastState()
      // Initial snapshot to the new subscriber.
      await sendTo(sub, { type: 'state', ...snapshotState() })

      const cleanup = () => {
        if (subscribers.delete(sub)) void broadcastState()
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

  // Submit pulse: tells any waiting CLI watchers that the human is done.
  // Submit is idempotent on the wire; the UI is responsible for greying
  // out the button once the user has clicked it.
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

  return app
}

export function startServer(options: {
  port: number
  host: string
  clientDir: string
  customDiffArgs?: string[]
}): Promise<{ port: number }> {
  const app = createApp(options.clientDir, options.customDiffArgs)

  return new Promise((resolve) => {
    const server = serve({
      fetch: app.fetch,
      port: options.port,
      hostname: options.host,
    }, (info) => {
      resolve({ port: info.port })
    })
  })
}
