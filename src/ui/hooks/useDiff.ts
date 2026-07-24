import { useState, useEffect, useCallback, useRef } from 'react'
import type { RefreshMode } from './useSettings'
import type { FilesChangedEvent } from '../../types'

export interface BinaryFileInfo {
  path: string
  type: 'added' | 'deleted' | 'changed' | 'untracked'
}

// Per-side file contents bundled into /api/diff. Used to construct
// non-partial FileDiffMetadata so CodeView can render expand-context UI.
// Files that exceed the server's per-file cap come back as `oversize`;
// missing-at-ref (added/deleted file) comes back as `missing`. CodeView
// falls back to patch-only rendering in either case.
export type SideContents =
  | { contents: string }
  | { binary: true }
  | { oversize: true; size: number }
  | { missing: true }

export type FileContentsMap = Record<string, { old: SideContents; new: SideContents }>

interface DiffData {
  patch: string
  repoName: string
  branch: string
  customMode: boolean
  binaryFiles: BinaryFileInfo[]
  untrackedFiles: string[]
  fileContents: FileContentsMap
}

// Scoped shape returned by GET /api/diff?file=<path>[&file=<path>...] — same
// fields, but binaryFiles/untrackedFiles/fileContents only ever mention the
// requested path(s), and `patch` is just the concatenation of those files'
// fragments (in request order; '' for a path with no pending diff). One
// `file=` param is the single-file case; repeated `file=` params (one per
// path, not a delimited list — repo-relative paths can contain commas) are
// the batch case used by loadFiles below.
type FileDiffData = DiffData

// Toolbar's staged/untracked toggle shape — kept narrow (and exported under
// its original name) because Toolbar's onDiffOptionsChange round-trips this
// exact shape through updateSettings. useDiff's own options are broader; see
// UseDiffOptions below.
export interface DiffOptions {
  staged: boolean
  untracked: boolean
}

export interface UseDiffOptions extends DiffOptions {
  // Governs how ambient fs-watcher `files-changed` (batched) and direct-edit
  // `file-changed` (single-file) events get applied. Does NOT gate
  // `file-written` (an explicit save via the in-browser editor) or the
  // path:null `krit refresh` signal — both of those are the user or agent
  // asking directly, so they always apply immediately regardless of mode.
  refreshMode: RefreshMode
  // Files the user is currently "in" (open draft/suggest form, file-editor
  // modal) — only consulted in 'live-unless-active' mode. An identity change
  // here does not need to be cheap; it's read from a ref, not an effect dep.
  activeFiles: Set<string>
}

// Replace (or remove, or append) several files' fragments within a full
// unified patch, in a single pass over `fullPatch`'s lines. Mirrors the
// server's extractFilePatch boundary logic so a batch refetch can be
// spliced back into the client's merged patch without re-fetching every
// other file, and without re-scanning the whole patch once per path.
function spliceFilePatches(fullPatch: string, fragments: Map<string, string>): string {
  const lines = fullPatch ? fullPatch.split('\n') : []
  const targetPrefix = 'diff --git a/'
  const remaining = new Set(fragments.keys())
  const result: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith(targetPrefix)) {
      result.push(lines[i])
      i++
      continue
    }
    const match = lines[i].match(/^diff --git a\/.+ b\/(.+)$/)
    const path = match?.[1]
    let end = i + 1
    while (end < lines.length && !lines[end].startsWith(targetPrefix)) end++
    if (path !== undefined && fragments.has(path)) {
      const fragment = fragments.get(path)!
      if (fragment) result.push(...fragment.split('\n'))
      remaining.delete(path)
    } else {
      result.push(...lines.slice(i, end))
    }
    i = end
  }
  // Any fragment whose path wasn't previously in the patch — nothing to
  // remove; append if there's something to add.
  for (const path of remaining) {
    const fragment = fragments.get(path)!
    if (fragment) result.push(...fragment.split('\n'))
  }
  return result.join('\n')
}

// Single-path convenience wrapper around spliceFilePatches, used by the
// file-written / single file-changed paths below.
function spliceFilePatch(fullPatch: string, filePath: string, fragment: string): string {
  return spliceFilePatches(fullPatch, new Map([[filePath, fragment]]))
}

// Split a patch response scoped to a known set of paths (as returned by
// GET /api/diff?file=...&file=...) into one fragment per file, keyed by the
// file's b/-side path — the inverse of spliceFilePatches. Used to distribute
// a single batch response across each path's slot in the merged patch.
function splitFilePatches(patch: string): Map<string, string> {
  const fragments = new Map<string, string>()
  if (!patch) return fragments
  const lines = patch.split('\n')
  const targetPrefix = 'diff --git a/'
  let path: string | null = null
  let start = 0
  const flush = (end: number) => {
    if (path !== null) fragments.set(path, lines.slice(start, end).join('\n'))
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(targetPrefix)) continue
    flush(i)
    const match = lines[i].match(/^diff --git a\/.+ b\/(.+)$/)
    path = match?.[1] ?? null
    start = i
  }
  flush(lines.length)
  return fragments
}

export function useDiff(options: UseDiffOptions) {
  const [data, setData] = useState<DiffData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Files a `files-changed`/`file-changed` event named but that refreshMode
  // deferred instead of applying — surfaced to the UI as a "N files changed"
  // toast / file-tree badge. Never populated by `file-written` (always
  // applies immediately).
  const [staleFiles, setStaleFiles] = useState<Set<string>>(() => new Set())

  // Mirrors `data` for the merge path below, which runs inside an event
  // handler closure that would otherwise see a stale `data` from the render
  // that registered the EventSource listener.
  const dataRef = useRef<DiffData | null>(null)
  dataRef.current = data
  // refreshMode/activeFiles are read from refs (not effect deps) so a
  // setting change or an active-file toggle doesn't tear down and
  // reconnect the EventSource.
  const refreshModeRef = useRef(options.refreshMode)
  refreshModeRef.current = options.refreshMode
  const activeFilesRef = useRef(options.activeFiles)
  activeFilesRef.current = options.activeFiles

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    return fetch(`/api/diff?staged=${options.staged}&untracked=${options.untracked}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [options.staged, options.untracked])

  // Targeted refetch: pull just one file's diff and splice it into the
  // current merged state, instead of re-fetching and re-parsing everything.
  // Falls back to a full load() if we don't have a base diff to merge into
  // yet (e.g. the file-written event races the initial load).
  const loadFile = useCallback(
    (path: string) => {
      const base = dataRef.current
      if (!base) return load()
      return fetch(`/api/diff?staged=${options.staged}&untracked=${options.untracked}&file=${encodeURIComponent(path)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json()
        })
        .then((json: FileDiffData) => {
          setData((prev) => {
            const cur = prev ?? base
            const patch = spliceFilePatch(cur.patch, path, json.patch)
            const binaryFiles = [...cur.binaryFiles.filter((b) => b.path !== path), ...json.binaryFiles]
            const untrackedFiles = json.untrackedFiles.length
              ? [...new Set([...cur.untrackedFiles, ...json.untrackedFiles])]
              : cur.untrackedFiles.filter((f) => f !== path)
            const fileContents = { ...cur.fileContents }
            if (path in json.fileContents) {
              fileContents[path] = json.fileContents[path]
            } else {
              delete fileContents[path]
            }
            return { ...cur, patch, binaryFiles, untrackedFiles, fileContents }
          })
        })
        .catch((err) => setError(err.message))
    },
    [options.staged, options.untracked, load],
  )

  // Batch refetch: pull several files' diffs in ONE request/ONE server-side
  // git diff and splice every fragment into the current merged state via a
  // single setData — the `files-changed` counterpart to loadFile's single-path
  // case, used so a burst of N changed files costs one round trip instead of
  // N. Same fallback-to-load() behavior as loadFile if there's no base diff
  // to merge into yet.
  const loadFiles = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return Promise.resolve()
      const base = dataRef.current
      if (!base) return load()
      const fileParams = paths.map((p) => `file=${encodeURIComponent(p)}`).join('&')
      return fetch(`/api/diff?staged=${options.staged}&untracked=${options.untracked}&${fileParams}`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json()
        })
        .then((json: FileDiffData) => {
          // The response's `patch` is the concatenation of just these paths'
          // fragments (server contract) — split it back into per-path
          // fragments so each one can be spliced into its own slot in the
          // merged patch. A requested path absent from the response has no
          // pending diff (reverted between event and request); splice ''
          // for it, mirroring the single-file semantics.
          const fragments = splitFilePatches(json.patch)
          for (const p of paths) {
            if (!fragments.has(p)) fragments.set(p, '')
          }
          setData((prev) => {
            const cur = prev ?? base
            const patch = spliceFilePatches(cur.patch, fragments)
            const pathSet = new Set(paths)
            const binaryFiles = [...cur.binaryFiles.filter((b) => !pathSet.has(b.path)), ...json.binaryFiles]
            const untrackedFiles = new Set(cur.untrackedFiles)
            for (const p of paths) untrackedFiles.delete(p)
            for (const f of json.untrackedFiles) untrackedFiles.add(f)
            const fileContents = { ...cur.fileContents }
            for (const p of paths) {
              if (p in json.fileContents) {
                fileContents[p] = json.fileContents[p]
              } else {
                delete fileContents[p]
              }
            }
            return { ...cur, patch, binaryFiles, untrackedFiles: [...untrackedFiles], fileContents }
          })
        })
        .catch((err) => setError(err.message))
    },
    [options.staged, options.untracked, load],
  )

  const markStale = useCallback((path: string) => {
    setStaleFiles((prev) => (prev.has(path) ? prev : new Set(prev).add(path)))
  }, [])

  const applyStaleFile = useCallback(
    (path: string) => {
      setStaleFiles((prev) => {
        if (!prev.has(path)) return prev
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      void loadFile(path)
    },
    [loadFile],
  )

  const applyAllStale = useCallback(() => {
    const paths = [...staleFiles]
    if (paths.length === 0) return
    setStaleFiles(new Set())
    void loadFiles(paths)
  }, [staleFiles, loadFiles])

  useEffect(() => {
    void load()
  }, [load])

  // SSE: react to file-written (explicit save, always applies immediately),
  // file-changed (a single direct edit/undo — see api_edits_delete/undo in
  // server.rs — gated by refreshMode same as before), and files-changed (the
  // ambient fs-watcher's batched replacement for the old per-file
  // file-changed fanout — one event per debounced tick, 1..N paths, gated by
  // refreshMode per path). `path: null` on file-written is the `krit
  // refresh` fallback and always does a full reload — both file-written and
  // that fallback are the user/agent asking directly, so they bypass
  // refreshMode entirely.
  useEffect(() => {
    const es = new EventSource('/api/events')
    es.addEventListener('message', (ev) => {
      try {
        const parsed = JSON.parse(ev.data)
        if (parsed.type === 'files-changed') {
          const paths = (parsed as FilesChangedEvent).paths
          if (!Array.isArray(paths) || paths.length === 0) return
          const mode = refreshModeRef.current
          if (mode === 'manual') {
            for (const p of paths) markStale(p)
            return
          }
          if (mode === 'ultra') {
            void loadFiles(paths)
            return
          }
          // live-unless-active: defer the subset the user is currently "in"
          // (open draft/suggest form, file-editor modal); apply the rest in
          // one batch refetch.
          const active = activeFilesRef.current
          const toApply: string[] = []
          for (const p of paths) {
            if (active.has(p)) markStale(p)
            else toApply.push(p)
          }
          void loadFiles(toApply)
          return
        }
        if (parsed.type !== 'file-written' && parsed.type !== 'file-changed') return
        const path: string | undefined = parsed.path ?? undefined
        if (!path) {
          void load()
          return
        }
        if (parsed.type === 'file-written') {
          void loadFile(path)
          return
        }
        // file-changed: gate on refreshMode.
        const mode = refreshModeRef.current
        if (mode === 'ultra') {
          void loadFile(path)
        } else if (mode === 'manual') {
          markStale(path)
        } else if (activeFilesRef.current.has(path)) {
          markStale(path)
        } else {
          void loadFile(path)
        }
      } catch {}
    })
    return () => es.close()
  }, [load, loadFile, loadFiles, markStale])

  // live-unless-active: once a deferred file stops being "active" (draft
  // closed, editor modal closed), apply the queued change automatically —
  // this is the "applies on close/submit" half of the mode.
  useEffect(() => {
    if (options.refreshMode !== 'live-unless-active' || staleFiles.size === 0) return
    const toApply = [...staleFiles].filter((p) => !options.activeFiles.has(p))
    if (toApply.length === 0) return
    setStaleFiles((prev) => {
      const next = new Set(prev)
      for (const p of toApply) next.delete(p)
      return next
    })
    void loadFiles(toApply)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.activeFiles, options.refreshMode, staleFiles, loadFiles])

  return {
    patch: data?.patch ?? null,
    repoName: data?.repoName ?? '',
    branch: data?.branch ?? '',
    customMode: data?.customMode ?? false,
    binaryFiles: data?.binaryFiles ?? [],
    untrackedFiles: data?.untrackedFiles ?? [],
    fileContents: data?.fileContents ?? {},
    loading,
    // True only before the first successful load. A background refetch
    // (SSE file-written, `krit refresh`) still flips `loading`, but the
    // caller already has `data` to render from — distinguishing the two
    // lets the UI keep the diff mounted (and its scroll position intact)
    // instead of unmounting to a full-page spinner on every refresh.
    initialLoading: loading && data === null,
    error,
    reload: load,
    staleFiles,
    applyStaleFile,
    applyAllStale,
  }
}
