import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

export interface DiffxState {
  port: number
  pid: number
  cwd: string
  host: string
  url: string
  startedAt: number
}

/**
 * Resolve the state-file path used to advertise a running diffx server.
 *
 * Priority:
 *   1. `DIFFX_STATE_FILE` env var (explicit override)
 *   2. `$CLAUDE_TMPDIR/diffx-state.json` — one diffx per Claude Code session
 *   3. `~/.diffx/state-<sha1(cwd)[:12]>.json` — keyed by cwd for plain shells
 */
export function defaultStatePath(): string {
  if (process.env.DIFFX_STATE_FILE) return process.env.DIFFX_STATE_FILE
  if (process.env.CLAUDE_TMPDIR) {
    return join(process.env.CLAUDE_TMPDIR, 'diffx-state.json')
  }
  const cwdHash = createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12)
  return join(homedir(), '.diffx', `state-${cwdHash}.json`)
}

export function writeState(state: DiffxState, path: string = defaultStatePath()): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2))
  return path
}

export function readState(path: string = defaultStatePath()): DiffxState | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as DiffxState
  } catch {
    return null
  }
}

export function removeState(path: string = defaultStatePath()): void {
  try {
    unlinkSync(path)
  } catch {
    // already gone, or never written
  }
}
