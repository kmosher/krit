import { useState, useEffect, useCallback, useRef } from 'react'
import type { RefreshMode } from './useSettings'

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

// Scoped shape returned by GET /api/diff?file=<path> — same fields, but
// binaryFiles/untrackedFiles/fileContents only ever mention that one path,
// and `patch` is just that file's fragment ('' if it has no pending diff).
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
  // Governs how ambient fs-watcher `file-changed` events get applied. Does
  // NOT gate `file-written` (an explicit save via the in-browser editor) or
  // the path:null `krit refresh` signal — both of those are the user or
  // agent asking directly, so they always apply immediately regardless of mode.
  refreshMode: RefreshMode
  // Files the user is currently "in" (open draft/suggest form, file-editor
  // modal) — only consulted in 'live-unless-active' mode. An identity change
  // here does not need to be cheap; it's read from a ref, not an effect dep.
  activeFiles: Set<string>
}

// Replace (or remove, or append) one file's fragment within a full unified
// patch. Mirrors the server's extractFilePatch boundary logic so a
// per-file refetch can be spliced back into the client's merged patch
// without re-fetching every other file.
function spliceFilePatch(fullPatch: string, filePath: string, fragment: string): string {
  const lines = fullPatch ? fullPatch.split('\n') : []
  const targetPrefix = 'diff --git a/'
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(targetPrefix)) continue
    const match = lines[i].match(/^diff --git a\/.+ b\/(.+)$/)
    if (start === -1) {
      if (match?.[1] === filePath) start = i
      continue
    }
    end = i
    break
  }
  const fragLines = fragment ? fragment.split('\n') : []
  if (start === -1) {
    // Not previously in the patch. Nothing to remove; append if there's
    // something to add.
    return fragment ? [...lines, ...fragLines].join('\n') : fullPatch
  }
  return [...lines.slice(0, start), ...fragLines, ...lines.slice(end)].join('\n')
}

export function useDiff(options: UseDiffOptions) {
  const [data, setData] = useState<DiffData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Files a `file-changed` event named but that refreshMode deferred instead
  // of applying — surfaced to the UI as a "N files changed" toast / file-tree
  // badge. Never populated by `file-written` (always applies immediately).
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
    for (const path of paths) void loadFile(path)
  }, [staleFiles, loadFile])

  useEffect(() => {
    void load()
  }, [load])

  // SSE: react to file-written (explicit save, always applies immediately)
  // and file-changed (ambient fs-watcher discovery, gated by refreshMode).
  // `path: null` is the `krit refresh` / batch fallback and always does a
  // full reload — both refresh signals are the user/agent asking directly,
  // so they bypass refreshMode entirely.
  useEffect(() => {
    const es = new EventSource('/api/events')
    es.addEventListener('message', (ev) => {
      try {
        const parsed = JSON.parse(ev.data)
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
  }, [load, loadFile, markStale])

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
    for (const p of toApply) void loadFile(p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.activeFiles, options.refreshMode, staleFiles, loadFile])

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
