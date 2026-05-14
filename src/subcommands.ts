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

export const SUBCOMMANDS = new Set(['state', 'comments', 'reply', 'resolve', 'reopen'])
