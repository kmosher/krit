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

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const state = requireState()
  const url = `${state.url}${path}`
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
  await api('POST', `/api/comments/${id}/replies`, { body })
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

/**
 * Block until the user clicks "Submit to Claude" in the diffx browser UI.
 *
 * Subscribes to the server's SSE stream with role=cli, which:
 *   - counts toward the UI's `watcherCount` (enabling the Submit button)
 *   - delivers a one-shot `submitted` event when the user clicks it
 *
 * Exit codes:
 *   0  — submit fired; the human is done reviewing
 *   2  — connection lost / server gone away (likely diffx server stopped)
 *   130 — interrupted (Ctrl+C) — node's standard SIGINT exit
 *
 * The orchestrating Claude session typically runs this in the background;
 * the task-completion notification is the wake-up signal to process comments.
 */
export async function cmdWaitForSubmit(): Promise<void> {
  const state = requireState()
  const url = `${state.url}/api/events?role=cli`

  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(130))

  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'text/event-stream' } })
  } catch (err) {
    console.error(`wait-for-submit: cannot reach diffx at ${url}: ${(err as Error).message}`)
    process.exit(2)
  }
  if (!res.ok || !res.body) {
    console.error(`wait-for-submit: SSE handshake failed (${res.status} ${res.statusText})`)
    process.exit(2)
  }

  console.error('wait-for-submit: connected — leave comments and click Submit in the browser.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      console.error('wait-for-submit: server closed the connection before submit fired.')
      process.exit(2)
    }
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
      let parsed: { type?: string; timestamp?: number }
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }
      if (parsed.type === 'submitted') {
        console.log(JSON.stringify({ submitted: true, timestamp: parsed.timestamp ?? null }))
        process.exit(0)
      }
    }
  }
}

export const SUBCOMMANDS = new Set(['state', 'comments', 'reply', 'resolve', 'reopen', 'wait-for-submit'])
