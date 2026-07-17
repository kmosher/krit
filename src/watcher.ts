import { watch, type FSWatcher } from 'chokidar'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

const DEBOUNCE_MS = 200

export interface RepoWatcher {
  close(): Promise<void>
}

/**
 * Watches the repo working tree and calls `onChange(relativePath)` at most
 * once per debounce window for each file that actually changed content.
 *
 * Two layers keep this quiet:
 *  - a per-path debounce, so a burst of writes (editor autosave, a build
 *    tool rewriting a file a few times) collapses to one callback;
 *  - a content hash per watched path, so events that fire without changing
 *    bytes — `git checkout` touching mtimes, a rebase, `touch` — are
 *    swallowed instead of triggering a broadcast.
 */
export function watchRepo(root: string, onChange: (path: string) => void): RepoWatcher {
  const hashes = new Map<string, string>()
  const pending = new Map<string, NodeJS.Timeout>()

  const hashOf = (absPath: string): string | null => {
    try {
      return createHash('sha1').update(readFileSync(absPath)).digest('hex')
    } catch {
      return null // deleted, unreadable, or raced with another writer
    }
  }

  const schedule = (absPath: string) => {
    const relPath = relative(root, absPath)
    const existing = pending.get(relPath)
    if (existing) clearTimeout(existing)
    pending.set(
      relPath,
      setTimeout(() => {
        pending.delete(relPath)
        const nextHash = hashOf(absPath)
        const prevHash = hashes.get(relPath)
        if (nextHash === null) {
          if (prevHash === undefined) return // already gone before we ever hashed it
          hashes.delete(relPath)
          onChange(relPath)
          return
        }
        if (nextHash === prevHash) return // mtime-only churn
        hashes.set(relPath, nextHash)
        onChange(relPath)
      }, DEBOUNCE_MS),
    )
  }

  const watcher: FSWatcher = watch(root, {
    ignored: (path: string) => /(^|\/)(\.git|node_modules)(\/|$)/.test(path),
    ignoreInitial: true,
    persistent: true,
  })
  watcher.on('add', schedule).on('change', schedule).on('unlink', schedule)

  return {
    close: () => watcher.close(),
  }
}
