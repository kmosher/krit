import { useState, useEffect, useCallback, useRef } from 'react'
import type { RefreshMode } from './useSettings'
import type { KritEvent } from '../../types'

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
  // THE refresh policy, stated once; everything else here points at this.
  //
  // Governs how ambient fs-watcher `files-changed` (batched) and direct-edit
  // `file-changed` (single-file) events get applied. `file-written` (an
  // explicit save through the in-browser editor) and the path:null `krit
  // refresh` signal bypass refreshMode entirely — those are the user or agent
  // asking directly — EXCEPT for a path in editingFiles, which nothing
  // refetches.
  refreshMode: RefreshMode
  // Files the user is currently "in" (open draft/suggest form, file-editor
  // modal) — only consulted in 'live-unless-active' mode. An identity change
  // here does not need to be cheap; it's read from a ref, not an effect dep.
  activeFiles: Set<string>
  // Files with a live inline editor. Narrower than activeFiles, and the one
  // exception carved out of the refreshMode rule above: a refetch replaces the
  // item's fileDiff, and for these paths that discards a live document and its
  // undo history. Their changes queue in staleFiles instead and reach the
  // editor through applyExternalEdit.
  editingFiles: Set<string>
}

// Ordering for diff refetches, which HTTP gives us none of. Two fetches of the
// same path are routinely in flight at once (a `file-written` and a watcher
// tick 200ms apart), and if the older read resolves second it wins and the
// diff settles on stale content with nothing left to correct it. So every
// fetch takes a monotonic id and claims the paths it covers; on arrival a
// response may only write the paths it is still the newest claim for. A full
// reload covers every path, so it supersedes every scoped request outstanding
// when it starts, and is itself dropped if anything started after it.
export class DiffRequestLedger {
  private seq = 0
  private newestForPath = new Map<string, number>()
  private newestFull = 0

  beginFull(): number {
    const id = ++this.seq
    this.newestFull = id
    this.newestForPath.clear()
    return id
  }

  beginPaths(paths: Iterable<string>): number {
    const id = ++this.seq
    for (const p of paths) this.newestForPath.set(p, id)
    return id
  }

  isCurrentFull(id: number): boolean {
    return id === this.seq
  }

  // The subset of `paths` this response is still the authority on. Partial is
  // normal and useful: a burst may have re-requested one path of five, and the
  // other four are still this response's to write.
  currentPaths(id: number, paths: readonly string[]): string[] {
    if (this.newestFull > id) return []
    return paths.filter((p) => this.newestForPath.get(p) === id)
  }
}

// The b/-side path out of a `diff --git a/X b/Y` header, or null if the line
// isn't one. A path may itself contain " b/" (`foo b/bar.rs` yields
// `diff --git a/foo b/bar.rs b/foo b/bar.rs`), so neither the first nor the
// last " b/" is reliably the separator. Absent a rename git writes the same
// path on both sides, so the split point is fixed by length: the b/-side is
// the trailing half of `a/`-stripped remainder. Only when that reconstruction
// doesn't match — a rename, where the sides genuinely differ — do we fall back
// to the first " b/", which is unambiguous for the paths git can produce there
// (a path needing a literal " b/" on one side of a rename is quoted by git).
export function diffHeaderPath(line: string): string | null {
  const rest = line.startsWith('diff --git a/') ? line.slice('diff --git a/'.length) : null
  if (rest === null) return null
  const half = (rest.length - 3) / 2
  if (Number.isInteger(half) && half > 0) {
    const candidate = rest.slice(rest.length - half)
    if (rest === `${candidate} b/${candidate}`) return candidate
  }
  const sep = rest.indexOf(' b/')
  return sep === -1 ? null : rest.slice(sep + 3)
}

// Replace (or remove, or append) several files' fragments within a full
// unified patch, in a single pass over `fullPatch`'s lines. Mirrors the
// boundary logic of `extract_file_patch` in krit/src/server.rs so a batch
// refetch can be spliced back into the client's merged patch without
// re-fetching every other file, and without re-scanning the whole patch once
// per path.
export function spliceFilePatches(fullPatch: string, fragments: Map<string, string>): string {
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
    const path = diffHeaderPath(lines[i]) ?? undefined
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

// Above this many paths in one tick, a batch refetch's request line (one
// repeated file= param per path, tens of bytes each once URL-encoded) grows
// into the tens of KB where proxies / h1 parsers start rejecting it — which
// would fail the WHOLE batch. Past the cap we fall back to one full reload:
// cheaper than a giant request, and it can't overflow the request line. This
// is exactly the mass-checkout/rebase burst the coalescing targets.
const BATCH_REFETCH_MAX = 40

// Split a patch response scoped to a known set of paths (as returned by
// GET /api/diff?file=...&file=...) into one fragment per file, keyed by the
// file's b/-side path — the inverse of spliceFilePatches. Used to distribute
// a single batch response across each path's slot in the merged patch.
export function splitFilePatches(patch: string): Map<string, string> {
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
    path = diffHeaderPath(lines[i])
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
  // toast / file-tree badge. Also populated by `file-written` for a file with
  // a live editor, which is the one case that event doesn't apply immediately.
  const [staleFiles, setStaleFiles] = useState<Set<string>>(() => new Set())
  // The queue's synchronous truth. State alone is not enough: an SSE frame and
  // a click can land in the same tick, before React re-renders, and a reader
  // that saw only the previous render's set would clear a path it never
  // fetched. Every mutation goes through commitStale so the two never diverge.
  const staleFilesRef = useRef<Set<string>>(staleFiles)
  const commitStale = useCallback((next: Set<string>) => {
    staleFilesRef.current = next
    setStaleFiles(next)
  }, [])

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
  const editingFilesRef = useRef(options.editingFiles)
  editingFilesRef.current = options.editingFiles

  const ledgerRef = useRef(new DiffRequestLedger())
  // Scoped fetches still in flight. A full reload's answer contains all of
  // theirs, so it aborts them rather than letting them resolve and re-write
  // paths from an older read. Scoped requests don't abort each other: one
  // controller can cover several paths, and only some of them are superseded
  // — the ledger sorts that out at merge time instead.
  const inFlightRef = useRef<Set<AbortController>>(new Set())
  const isAbort = (err: unknown) => err instanceof Error && err.name === 'AbortError'

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    const id = ledgerRef.current.beginFull()
    for (const c of inFlightRef.current) c.abort()
    inFlightRef.current.clear()
    return fetch(`/api/diff?staged=${options.staged}&untracked=${options.untracked}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json) => {
        if (ledgerRef.current.isCurrentFull(id)) setData(json)
      })
      .catch((err) => {
        if (!isAbort(err)) setError(err.message)
      })
      .finally(() => setLoading(false))
  }, [options.staged, options.untracked])

  // Batch refetch: pull several files' diffs in ONE request / ONE server-side
  // git diff and splice every fragment into the current merged state via a
  // single setData, so a burst of N changed files (a `files-changed` tick)
  // costs one round trip instead of N. loadFile below is the single-path case.
  const loadFiles = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return Promise.resolve()
      const base = dataRef.current
      // No base to merge into yet, or a burst too large to batch safely — one
      // full reload instead (see BATCH_REFETCH_MAX).
      if (!base || paths.length > BATCH_REFETCH_MAX) return load()
      const fileParams = paths.map((p) => `file=${encodeURIComponent(p)}`).join('&')
      const id = ledgerRef.current.beginPaths(paths)
      const controller = new AbortController()
      inFlightRef.current.add(controller)
      return fetch(`/api/diff?staged=${options.staged}&untracked=${options.untracked}&${fileParams}`, {
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json()
        })
        .then((json: FileDiffData) => {
          // Only the paths this response is still the newest read of; a path
          // re-requested while this one was in flight belongs to that later
          // request, and writing it here would install the older content.
          const own = ledgerRef.current.currentPaths(id, paths)
          if (own.length === 0) return
          // The response's `patch` is the concatenation of just these paths'
          // fragments (server contract) — split it back into per-path
          // fragments so each one can be spliced into its own slot in the
          // merged patch. A requested path absent from the response has no
          // pending diff (reverted between event and request); splice ''
          // for it, mirroring the single-file semantics.
          const all = splitFilePatches(json.patch)
          const fragments = new Map<string, string>()
          for (const p of own) fragments.set(p, all.get(p) ?? '')
          setData((prev) => {
            const cur = prev ?? base
            const patch = spliceFilePatches(cur.patch, fragments)
            const pathSet = new Set(own)
            const binaryFiles = [
              ...cur.binaryFiles.filter((b) => !pathSet.has(b.path)),
              ...json.binaryFiles.filter((b) => pathSet.has(b.path)),
            ]
            const untrackedFiles = new Set(cur.untrackedFiles)
            for (const p of own) untrackedFiles.delete(p)
            for (const f of json.untrackedFiles) {
              if (pathSet.has(f)) untrackedFiles.add(f)
            }
            const fileContents = { ...cur.fileContents }
            for (const p of own) {
              if (p in json.fileContents) {
                fileContents[p] = json.fileContents[p]
              } else {
                delete fileContents[p]
              }
            }
            return { ...cur, patch, binaryFiles, untrackedFiles: [...untrackedFiles], fileContents }
          })
        })
        .catch((err) => {
          if (!isAbort(err)) setError(err.message)
        })
        .finally(() => {
          inFlightRef.current.delete(controller)
        })
    },
    [options.staged, options.untracked, load],
  )

  // Single-path refetch (file-written, a single direct-edit file-changed) — the
  // 1-element case of loadFiles, kept as one merge implementation.
  const loadFile = useCallback((path: string) => loadFiles([path]), [loadFiles])

  const markStale = useCallback(
    (path: string) => {
      if (staleFilesRef.current.has(path)) return
      commitStale(new Set(staleFilesRef.current).add(path))
    },
    [commitStale],
  )

  // Drop a path from the stale set without refetching its diff. For a file
  // with an open edit session, the caller applies the change into the editor
  // instead (see applyExternalEdit) — refetching would replace the item's
  // fileDiff and take the live document, and its undo history, with it.
  const dismissStale = useCallback(
    (path: string) => {
      if (!staleFilesRef.current.has(path)) return
      const next = new Set(staleFilesRef.current)
      next.delete(path)
      commitStale(next)
    },
    [commitStale],
  )

  const applyStaleFile = useCallback(
    (path: string) => {
      dismissStale(path)
      void loadFile(path)
    },
    [loadFile, dismissStale],
  )

  // `skip` holds paths the caller is applying some other way — in practice
  // files with an open edit session, which take their change through the
  // editor. They stay queued so their own apply affordance survives this batch.
  const applyAllStale = useCallback(
    (skip?: Set<string>) => {
      const toApply: string[] = []
      const retained = new Set<string>()
      for (const p of staleFilesRef.current) {
        if (skip?.has(p)) retained.add(p)
        else toApply.push(p)
      }
      if (toApply.length === 0) return
      commitStale(retained)
      void loadFiles(toApply)
    },
    [loadFiles, commitStale],
  )

  useEffect(() => {
    void load()
  }, [load])

  // SSE: file-written (an explicit save), file-changed (a single direct
  // edit/undo — see api_edits_delete/undo in server.rs), and files-changed
  // (the ambient fs-watcher's batched replacement for the old per-file
  // file-changed fanout — one event per debounced tick, 1..N paths). Which of
  // those apply and which queue is UseDiffOptions.refreshMode's rule; this
  // effect only implements it. `path: null` on file-written is the `krit
  // refresh` fallback and does a full reload.
  useEffect(() => {
    // `role=ui` is what makes this subscriber count as a browser: the server
    // defaults an unstated role to a CLI client, which neither holds the
    // review server alive nor gates the Done-reviewing button.
    const es = new EventSource('/api/events?role=ui')
    es.addEventListener('message', (ev) => {
      try {
        // Typed against the wire union so a Rust-side rename fails `tsc`
        // rather than silently stopping the refresh loop.
        const event = JSON.parse(ev.data) as KritEvent
        if (event.type === 'files-changed') {
          const paths = event.paths
          if (!Array.isArray(paths) || paths.length === 0) return
          // Partition, rather than deciding for the batch as a whole: the
          // editing-file exception is per path in every mode, and so is
          // live-unless-active's deferral of files the user is currently "in"
          // (open draft/suggest form, file-editor modal). Whatever's left
          // applies in one batch refetch.
          const mode = refreshModeRef.current
          const editing = editingFilesRef.current
          const active = activeFilesRef.current
          const toApply: string[] = []
          for (const p of paths) {
            const defer =
              editing.has(p) || mode === 'manual' || (mode === 'live-unless-active' && active.has(p))
            if (defer) markStale(p)
            else toApply.push(p)
          }
          void loadFiles(toApply)
          return
        }
        if (event.type !== 'file-written' && event.type !== 'file-changed') {
          // Every other variant belongs to another consumer (useComments,
          // useReviewState). Enumerated rather than defaulted so a new Rust
          // variant has to be considered here.
          const other: Exclude<KritEvent, { type: 'file-written' | 'file-changed' | 'files-changed' }> =
            event
          void other
          return
        }
        const path = event.path
        if (!path) {
          // file-written's `path: null` — the `krit refresh` fallback.
          void load()
          return
        }
        // A path with a live editor never refetches, in any mode: the refetch
        // would swap out the item's fileDiff and take the open document with
        // it. Queue it instead — applyExternalEdit is how it reaches the
        // editor. Checked ahead of the per-type split below so it also covers
        // `file-written`, which otherwise applies unconditionally; the
        // files-changed branch above applies the same rule per path.
        if (editingFilesRef.current.has(path)) {
          markStale(path)
          return
        }
        if (event.type === 'file-written') {
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
  //
  // editingFiles is excluded on its own account rather than by trusting the
  // caller to have merged it into activeFiles. Auto-applying here is a
  // refetch, which is the one thing a live editor must never be handed: the
  // queued change stays put until the session ends or Apply routes it through
  // the editor.
  useEffect(() => {
    if (options.refreshMode !== 'live-unless-active' || staleFiles.size === 0) return
    const toApply = [...staleFiles].filter(
      (p) => !options.activeFiles.has(p) && !options.editingFiles.has(p),
    )
    if (toApply.length === 0) return
    const next = new Set(staleFilesRef.current)
    for (const p of toApply) next.delete(p)
    commitStale(next)
    void loadFiles(toApply)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.activeFiles, options.editingFiles, options.refreshMode, staleFiles, loadFiles])

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
    dismissStale,
  }
}
