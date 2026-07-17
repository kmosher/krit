import { readState, type DiffxState } from './state.js'

function requireState(): DiffxState {
  const state = readState()
  if (!state) {
    console.error('Error: no running diffx server found for this session.')
    console.error('Start one with `diffx` first, or set DIFFX_STATE_FILE to a state-file path.')
    process.exit(1)
  }
  return state
}

function baseUrl(state: DiffxState): string {
  // 127.0.0.1 → localhost so sandbox host allowlists (which only accept
  // the name) don't block the loopback connection.
  return state.url.replace('://127.0.0.1', '://localhost')
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const state = requireState()
  const url = `${baseUrl(state)}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    console.error(`Error reaching diffx at ${url}: ${(err as Error).message}`)
    console.error('The state file points to a server that is not responding. Did diffx crash?')
    process.exit(1)
  }
  if (!res.ok) {
    console.error(`Error: ${res.status} ${res.statusText} from ${method} ${url}`)
    const text = await res.text().catch(() => '')
    if (text) console.error(text)
    process.exit(1)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    return (await res.json()) as T
  }
  return undefined as T
}

export function cmdState(): void {
  const state = requireState()
  console.log(JSON.stringify(state, null, 2))
}

export async function cmdComments(filter: 'open' | 'resolved' | 'replied' | 'all' = 'all'): Promise<void> {
  const comments = await api<Array<{ status: string; replies: unknown[] }>>('GET', '/api/comments')
  let filtered = comments
  if (filter === 'open') filtered = comments.filter((c) => c.status === 'open')
  else if (filter === 'resolved') filtered = comments.filter((c) => c.status === 'resolved')
  else if (filter === 'replied') filtered = comments.filter((c) => c.status === 'open' && c.replies.length > 0)
  console.log(JSON.stringify(filtered, null, 2))
}

export async function cmdReply(id: string | undefined, body: string | undefined): Promise<void> {
  if (!id || !body) {
    console.error('Usage: diffx reply <comment-id> <text>')
    process.exit(1)
  }
  // ?source=cli prevents this reply from being broadcast as a `reply-added`
  // event, which would otherwise wake up `diffx watch` (i.e. ourselves).
  await api('POST', `/api/comments/${id}/replies?source=cli`, { body })
  console.log(`replied to ${id}`)
}

export async function cmdResolve(id: string | undefined): Promise<void> {
  if (!id) {
    console.error('Usage: diffx resolve <comment-id>')
    process.exit(1)
  }
  await api('PUT', `/api/comments/${id}`, { status: 'resolved' })
  console.log(`resolved ${id}`)
}

export async function cmdReopen(id: string | undefined): Promise<void> {
  if (!id) {
    console.error('Usage: diffx reopen <comment-id>')
    process.exit(1)
  }
  await api('PUT', `/api/comments/${id}`, { status: 'open' })
  console.log(`reopened ${id}`)
}

export async function cmdRefresh(): Promise<void> {
  // Tells the browser tab to refetch /api/diff. Needed after edits made
  // outside the in-browser editor (e.g. an agent's own Edit tool), since
  // those writes never hit PUT /api/file-content and so never broadcast
  // file-written on their own.
  await api('POST', '/api/refresh')
  console.log('refreshed')
}

type SseEvent = { type?: string; [k: string]: unknown }

/**
 * Connects to the diffx server's SSE stream as role=cli and invokes
 * `onEvent` for each parsed event. Resolves only when the server closes
 * the stream; never returns on its own. Exits the process on connect
 * failure (code 2).
 */
async function streamEvents(label: string, onEvent: (ev: SseEvent) => void): Promise<void> {
  const state = requireState()
  const url = `${baseUrl(state)}/api/events?role=cli`

  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(130))

  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'text/event-stream' } })
  } catch (err) {
    console.error(`${label}: cannot reach diffx at ${url}: ${(err as Error).message}`)
    process.exit(2)
  }
  if (!res.ok || !res.body) {
    console.error(`${label}: SSE handshake failed (${res.status} ${res.statusText})`)
    process.exit(2)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    let value: Uint8Array | undefined
    let done: boolean
    try {
      ;({ value, done } = await reader.read())
    } catch {
      // The server going away mid-stream (killed, crashed, Ctrl+C) surfaces
      // as a socket error here rather than a clean `done: true` read. Treat
      // it the same as a graceful close — the caller decides what an
      // unexpected disconnect means (e.g. exit code).
      return
    }
    if (done) return
    buf += decoder.decode(value, { stream: true })
    // SSE events are separated by a blank line.
    let idx: number
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const dataLines = frame
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
      if (dataLines.length === 0) continue
      const data = dataLines.join('\n')
      if (!data) continue // ping
      let parsed: SseEvent
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }
      onEvent(parsed)
    }
  }
}

/**
 * Block until the user clicks "Done reviewing" in the diffx browser UI.
 *
 * Exit codes: 0 on submit, 2 on connection loss, 130 on Ctrl+C.
 *
 * Retained for the batch-review workflow. The streaming flow uses
 * `diffx watch` instead — see cmdWatch below.
 */
export async function cmdWaitForSubmit(): Promise<void> {
  console.error('wait-for-submit: connected — leave comments and click Done reviewing in the browser.')
  await streamEvents('wait-for-submit', (ev) => {
    if (ev.type === 'submitted') {
      console.log(JSON.stringify({ submitted: true, timestamp: ev.timestamp ?? null }))
      process.exit(0)
    }
  })
  console.error('wait-for-submit: server closed the connection before submit fired.')
  process.exit(2)
}

// Debounce window for turning `state` snapshots into a `clients` presence
// line — long enough that a browser tab reload (which drops and immediately
// re-opens the SSE connection) reads as "still there" instead of a
// leave-then-rejoin blip.
const CLIENTS_DEBOUNCE_MS = 4000

/**
 * Stream comment events from the diffx UI, one JSON line per event.
 *
 * Designed to run as a long-lived Monitor task: each printed line is a
 * wake-up notification for the orchestrating Claude session. "Done
 * reviewing" is NOT terminal — comments/replies can keep arriving after it,
 * so watch stays connected and keeps streaming them. It only exits once the
 * diffx server itself shuts down. The server keys its own shutdown on
 * browser (not watcher) presence — see reason codes below — so this command
 * is never what keeps a review "stuck open."
 *
 * Exit codes: 0 if `submitted` was ever seen; 3 if the server broadcast
 * `review-ended` (reviewer left without submitting) before submitting; 2 if
 * the connection just drops with neither; 130 on Ctrl+C.
 *
 * Emitted line shapes (one per line, newline-terminated):
 *   {"type":"comment-added","comment":{...}}
 *   {"type":"reply-added","commentId":"...","reply":{...}}
 *   {"type":"comment-updated","comment":{...}}  // re-anchored after a live
 *                                                 file edit shifted its lines,
 *                                                 or newly/no-longer outdated
 *   {"type":"user-edit","action":"delete","filePath":"...","range":{...},"deletedText":"..."}
 *                                                // a direct in-browser delete (or "undo") --
 *                                                // a context update, not a request; the file
 *                                                // already reflects it, don't re-apply it
 *   {"type":"clients","browsers":N}             // debounced browser-tab presence
 *   {"type":"submitted","timestamp":...}        // not final — watch keeps streaming after this
 *   {"type":"review-ended","reason":"idle"|"no-browser"}  // terminal
 */
export async function cmdWatch(): Promise<void> {
  console.error('watch: connected — streaming comment events.')
  let submitted = false
  let lastEmittedBrowsers = -1
  let pendingBrowsers: number | null = null
  let clientsDebounce: NodeJS.Timeout | undefined

  const flushClients = () => {
    if (pendingBrowsers === null || pendingBrowsers === lastEmittedBrowsers) return
    lastEmittedBrowsers = pendingBrowsers
    process.stdout.write(JSON.stringify({ type: 'clients', browsers: lastEmittedBrowsers }) + '\n')
  }

  await streamEvents('watch', (ev) => {
    if (ev.type === 'comment-added' || ev.type === 'reply-added' || ev.type === 'comment-updated' || ev.type === 'user-edit') {
      process.stdout.write(JSON.stringify(ev) + '\n')
    } else if (ev.type === 'submitted') {
      submitted = true
      process.stdout.write(JSON.stringify(ev) + '\n')
    } else if (ev.type === 'review-ended') {
      // Terminal event — exit now instead of waiting for the connection to
      // close. The server tears itself down right after broadcasting this,
      // and holding our SSE stream open only delays (older builds: deadlocks)
      // that shutdown.
      if (clientsDebounce) clearTimeout(clientsDebounce)
      process.stdout.write(JSON.stringify(ev) + '\n')
      console.error('watch: reviewer left without submitting.')
      process.exit(3)
    } else if (ev.type === 'state') {
      // Was previously swallowed entirely; now debounced into a `clients`
      // presence line so the agent can tell whether anyone's still reviewing.
      pendingBrowsers = typeof ev.uiCount === 'number' ? ev.uiCount : 0
      if (clientsDebounce) clearTimeout(clientsDebounce)
      clientsDebounce = setTimeout(flushClients, CLIENTS_DEBOUNCE_MS)
    }
    // pings are intentionally swallowed.
  })
  if (clientsDebounce) clearTimeout(clientsDebounce)

  if (submitted) {
    console.error('watch: server shut down after Done reviewing.')
    process.exit(0)
  }
  console.error('watch: server closed the connection before Done reviewing.')
  process.exit(2)
}

export const SUBCOMMANDS = new Set(['state', 'comments', 'reply', 'resolve', 'reopen', 'wait-for-submit', 'watch', 'refresh'])
