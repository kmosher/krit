import { useState, useRef, useMemo, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, memo } from 'react'
import { CodeView, EditProvider, useStableCallback, type CodeViewHandle } from '@pierre/diffs/react'
import { Editor, type EditorOptions } from '@pierre/diffs/edit'
import type {
  CodeViewItem,
  CodeViewOptions,
  DiffLineAnnotation,
  FileDiffMetadata,
  AnnotationSide,
  SelectedLineRange,
  SelectionSide,
} from '@pierre/diffs'
import type { ReviewComment } from '../../types'
import { CommentForm } from './CommentForm'
import { CommentBubble } from './CommentBubble'
import { SelectionPill } from './SelectionPill'
import {
  mapRangeToAnchor,
  rangeFromClick,
  rangeFromDragPoints,
  type DragPoint,
  type SelectionAnchor,
} from '../utils/selectionMapping'
import { computeSingleEdit } from '../utils/textEdits'

type DraftMetadata = {
  _pending: true
  itemId: string
  side: AnnotationSide
  startLine: number
  endLine: number
  // In-progress form text, lifted out of CommentForm's local state so a
  // structural add/remove remount doesn't discard what the user was typing.
  body: string
  suggestMode: boolean
  suggestionText: string
  // Set when this draft originated from a native text selection
  // (SelectionPill) rather than a gutter-drag — schema v3's character-level
  // anchor, threaded through to onAddComment on submit/save-draft.
  charAnchor?: { startColumn: number; endColumn: number; selectedText: string }
}
type Metadata = ReviewComment | DraftMetadata

function truncateForLabel(text: string, max = 40): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

// A draft is uniquely identified by file + side + line range. Clicking the +
// on a line that already has an open draft just focuses the existing form
// instead of stacking a second one in the same slot.
const NUL = String.fromCharCode(0)
// A draft key joins its fields with a NUL separator (not a space): itemId
// is a file path, which can legally contain spaces, so a space separator
// could collide two different (path, side, range) tuples into the same
// key. NUL can't appear in any of these fields, so it can't collide.
// Built via String.fromCharCode rather than a literal byte or escape
// sequence in a template literal -- either of those previously left an
// actual NUL byte in this source file, which made git/`file` misclassify
// the whole file as binary and silently broke the production bundler.
function draftKey(d: Pick<DraftMetadata, 'itemId' | 'side' | 'startLine' | 'endLine'>): string {
  return [d.itemId, d.side, d.startLine, d.endLine].join(NUL)
}

// Every annotation (comment form, suggest-edit CodeMirror, comment bubble
// reply form) is mounted inside Pierre's CodeView annotation surface, which
// sits below CodeView's own document-level gutter-drag listeners in the
// DOM. Those listeners react to mousedown/mousemove/mouseup/keydown bubbling
// all the way up to document to implement line-selection drag -- with
// nothing stopping the bubble, dragging to select text inside our own form
// (e.g. the suggest-edit rewrite) gets hijacked into starting a gutter drag
// instead. Stopping propagation here -- after the event has already reached
// and been handled by CodeMirror's/the textarea's own internal DOM
// listeners, which fire before it bubbles this far up -- blocks it from ever
// reaching CodeView's document listeners, without touching CodeMirror's own
// event handling.
function stopBubble(e: React.SyntheticEvent) {
  e.stopPropagation()
}
function AnnotationEventGuard(props: { children: React.ReactNode }) {
  return (
    <div
      onMouseDown={stopBubble}
      onMouseMove={stopBubble}
      onMouseUp={stopBubble}
      onPointerDown={stopBubble}
      onPointerMove={stopBubble}
      onPointerUp={stopBubble}
      onKeyDown={stopBubble}
    >
      {props.children}
    </div>
  )
}

// Files whose +/- change count exceeds this start collapsed by default. Based
// on patch-derived stats (NOT FileDiffMetadata.unifiedLineCount) because after
// our parseDiffFromFile upgrade, unifiedLineCount is the full file's rendered
// line count, not the diff size — which would collapse every moderately-sized
// file regardless of whether the diff itself is large.
const AUTO_COLLAPSE_CHANGE_THRESHOLD = 500

// What CodeView needs to size an unrendered file: how tall one visual row is,
// how many characters fit on one before `overflow: 'wrap'` breaks it, and how
// tall a file header is. Pierre's own defaults (lineHeight 20, header 44) are
// estimates for *unwrapped* rows, so on a wrapped surface the reservation runs
// short by however much the diff wraps. Measured off the live surface rather
// than hardcoded: every one of these is set by the Pierre theme's CSS, which
// krit doesn't own and can change under it on a version bump.
export interface SurfaceMetrics {
  rowHeight: number
  charsPerRow: number
  headerHeight: number
}

// Cap on how many lines the wrap estimate reads per file. Full-file mode hands
// us whole files, so a large review can carry hundreds of thousands of lines;
// the estimate is an average, and an even stride over a few thousand samples
// converges to the same number as reading every line.
const WRAP_SAMPLE_LIMIT = 2000

// Frames to keep retrying the surface measurement before giving up and letting
// Pierre's own defaults stand.
const MEASURE_ATTEMPTS = 60

// Average visual rows per source line, in pixels — what to hand Pierre as
// `lineHeight`. Under-reserving is the bug being fixed here (the layout grows
// as rows are measured on approach, so the bottom recedes as you scroll toward
// it); over-reserving only leaves dead space the layout reclaims. When in
// doubt this rounds up.
export function estimateWrappedRowHeight(
  files: FileDiffMetadata[],
  metrics: Pick<SurfaceMetrics, 'rowHeight' | 'charsPerRow'>,
): number {
  const { rowHeight, charsPerRow } = metrics
  if (!(rowHeight > 0) || !(charsPerRow > 0)) return rowHeight
  let lines = 0
  let rows = 0
  for (const file of files) {
    for (const source of [file.additionLines, file.deletionLines]) {
      if (!source || source.length === 0) continue
      const stride = Math.max(1, Math.ceil(source.length / WRAP_SAMPLE_LIMIT))
      for (let i = 0; i < source.length; i += stride) {
        lines++
        // additionLines/deletionLines carry the trailing newline; neither it
        // nor a CRLF's carriage return occupies a column, and a stray \r would
        // push every full-width line in a CRLF repo onto a second row.
        const length = source[i].replace(/\r?\n$/, '').length
        rows += Math.max(1, Math.ceil(length / charsPerRow))
      }
    }
  }
  if (lines === 0) return rowHeight
  return Math.ceil((rows / lines) * rowHeight)
}

// Character advance width for a monospace font, via canvas rather than a probe
// element: the surface lives in Pierre's shadow root and its font stack is not
// in scope for anything krit renders, so the only honest measurement is to ask
// the shadow node for its computed font and measure that exact string.
let measureCanvas: HTMLCanvasElement | null = null
const CHAR_SAMPLE = 'x'.repeat(64)
function measureCharWidth(style: CSSStyleDeclaration): number {
  measureCanvas ??= document.createElement('canvas')
  const ctx = measureCanvas.getContext('2d')
  if (!ctx) return 0
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  return ctx.measureText(CHAR_SAMPLE).width / CHAR_SAMPLE.length
}

// Read the real geometry off whichever file happens to be rendered. Returns
// null until CodeView has painted at least one item — the caller retries.
function measureSurfaceMetrics(container: HTMLElement | null): SurfaceMetrics | null {
  const root = container?.querySelector('diffs-container')?.shadowRoot
  const content = root?.querySelector('[data-content]')
  if (!(content instanceof HTMLElement)) return null
  const style = getComputedStyle(content)
  const rowHeight = Number.parseFloat(style.lineHeight)
  const charWidth = measureCharWidth(style)
  const width = content.getBoundingClientRect().width
  if (!(rowHeight > 0) || !(charWidth > 0) || !(width > 0)) return null
  // Every rendered header, not just the first: krit's renderHeaderPrefix grows
  // a stale/Apply button and a confirm-save strip on the file being edited, and
  // Pierre reserves one flat height for all of them. Sizing to the tallest
  // over-reserves for the other files by that difference, which is the
  // direction that doesn't strand the bottom of the scroll.
  let headerHeight = 0
  for (const host of container?.querySelectorAll('diffs-container') ?? []) {
    const header = host.shadowRoot?.querySelector('[data-diffs-header]')
    if (header instanceof HTMLElement) {
      headerHeight = Math.max(headerHeight, Math.ceil(header.getBoundingClientRect().height))
    }
  }
  if (!(headerHeight > 0)) return null
  return { rowHeight, charsPerRow: Math.max(1, Math.floor(width / charWidth)), headerHeight }
}

export interface CodeViewWrapperHandle {
  scrollToFile(filePath: string): void
  scrollToLine(filePath: string, side: SelectionSide, lineNumber: number): void
  // Pull an external write (agent, git checkout, another editor) into an open
  // edit session as one undoable edit. Returns false when the file has no live
  // editor, which is the caller's signal to refetch the diff normally instead.
  applyExternalEdit(filePath: string, contents: string): boolean
}

interface Props {
  files: FileDiffMetadata[]
  diffStyle: 'split' | 'unified'
  defaultTabSize: number
  viewedFiles: Set<string>
  fileAnnotationsMap: Map<string, DiffLineAnnotation<ReviewComment>[]>
  commentCounts: Record<string, number>
  // Passed in rather than derived here. Neither source available to this
  // component can produce it: after the parseDiffFromFile upgrade
  // hunk.additionCount/deletionCount come back zero (that path exists for
  // expansion context, not stats), and FileDiffMetadata.additionLines is the
  // entire new file in full-file mode. The caller computes it off the patch
  // text, which is the only place the real +/- counts survive.
  fileStatsMap: Record<string, { additions: number; deletions: number }>
  onViewedChange(filePath: string, viewed: boolean): void
  onAddComment(
    filePath: string,
    side: AnnotationSide,
    lineNumber: number,
    endLine: number,
    lineContent: string,
    body: string,
    suggestion?: { newLines: string[] },
    asDraft?: boolean,
    // Schema v3: set when the comment was created from a SelectionPill
    // (native text selection) rather than a gutter-drag draft.
    charAnchor?: { startColumn: number; endColumn: number; selectedText: string },
  ): void
  onDeleteComment(id: string): void
  onReplyComment(id: string, body: string): void
  // SelectionPill's "Delete" — splices `anchor`'s exact character range out
  // of the working-tree file (server-side, via POST /api/edits/delete).
  onDeleteRange?(filePath: string, anchor: SelectionAnchor): void
  onActiveFileChange?(filePath: string | null): void
  // Whole-file fallback: opens FileEditorModal. Inline editing (below) is the
  // primary path; this one still reaches regions the diff doesn't render.
  onEditFile?(filePath: string): void
  // Files currently in inline edit mode — the diff's addition side becomes a
  // live editor in place. Mirrors `viewedFiles`: the parent owns the set and
  // we push it into `item.edit`.
  editingFiles: Set<string>
  onToggleEdit(filePath: string): void
  // Files with a queued external change. Only surfaced in the header for files
  // being edited — everywhere else the file tree and toolbar already say so.
  staleFiles: Set<string>
  onApplyStale(filePath: string): void
  // Files whose Done click is waiting on a "save over the queued change?"
  // answer. The header renders the question; App owns the set.
  confirmSaveFiles: Set<string>
  onCancelSaveConfirm(filePath: string): void
  // An inline edit session ended having changed something. Fires once per
  // session, not per keystroke; the parent writes `contents` to the working
  // tree. Pierre skips it entirely for sessions that made no changes.
  onEditComplete(filePath: string, contents: string): void
  // Fires whenever the set of files with an open draft (comment or suggest
  // form) changes. Feeds the 'live-unless-active' refresh-mode policy in
  // useDiff — a file with an open draft is "active" and its background
  // changes get queued instead of applied out from under the typing user.
  onActiveDraftsChange?(files: Set<string>): void
}

function getLineContent(
  fileDiff: FileDiffMetadata,
  side: AnnotationSide,
  lineNumber: number,
): string {
  const lines = side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines
  const startKey = side === 'additions' ? 'additionStart' : 'deletionStart'
  const countKey = side === 'additions' ? 'additionCount' : 'deletionCount'
  const indexKey = side === 'additions' ? 'additionLineIndex' : 'deletionLineIndex'
  for (const hunk of fileDiff.hunks) {
    const start = hunk[startKey]
    const count = hunk[countKey]
    if (lineNumber >= start && lineNumber < start + count) {
      const index = hunk[indexKey] + (lineNumber - start)
      return lines[index] ?? ''
    }
  }
  return ''
}

function getRangeContent(
  fileDiff: FileDiffMetadata,
  side: AnnotationSide,
  startLine: number,
  endLine: number,
): string {
  const out: string[] = []
  for (let n = startLine; n <= endLine; n++) {
    // FileDiffMetadata.additionLines/deletionLines stores raw source lines
    // with trailing newlines. If we join those with '\n' we end up with '\n\n'
    // between every captured line — strip the trailing newline per row so
    // the join produces clean single-newline separation. Skip truly empty
    // rows (lineNumber outside any hunk → '') so we don't insert phantom blanks.
    const raw = getLineContent(fileDiff, side, n)
    if (raw === '') continue
    out.push(raw.replace(/\n$/, ''))
  }
  return out.join('\n')
}

function bumpVersion(item: CodeViewItem<Metadata>): number {
  const v = typeof item.version === 'number' ? item.version : 0
  return v + 1
}

type DiffItem = Extract<CodeViewItem<Metadata>, { type: 'diff' }>

// Push a per-file change into CodeView's item list.
//
// Every sync below has the same body: walk `files`, ask whether this file
// moved since the last run, and for the ones that did, fetch the item,
// mutate it, bump `version` (CodeView re-renders an item only when that
// changes), and hand it back. Each caller supplies only the two parts that
// differ — `changed`, and `mutate` for whatever field it owns.
//
// `mutate` is optional because a bump alone is meaningful: the header
// renderers read viewedFiles/staleFiles/commentCounts through their closures,
// so re-running them is the entire point of those syncs.
//
// Callers keep their own last-value snapshot in a ref and overwrite it after
// the walk. That bookkeeping stays with the caller rather than moving in
// here: `changed` is the only thing that knows what shape the snapshot is,
// and a helper that guessed would be wrong for the annotations sync (per-file
// deep compare) and the stale sync (which deliberately updates its snapshot
// for files it skipped).
function syncItems(
  viewer: CodeViewHandle<Metadata> | null,
  files: FileDiffMetadata[],
  changed: (name: string) => boolean,
  mutate?: (item: DiffItem, name: string) => void,
): void {
  if (!viewer) return
  for (const file of files) {
    if (!changed(file.name)) continue
    const item = viewer.getItem(file.name)
    if (!item || item.type !== 'diff') continue
    mutate?.(item, file.name)
    item.version = bumpVersion(item)
    viewer.updateItem(item)
  }
}

// Make sure every file we believe is being edited actually has an editor.
//
// Setting `item.edit` only *queues* a render, and Pierre attaches the editor
// from inside that pass — one attach attempt, no retry. Any exception raised
// earlier in the same pass aborts it before the attach line, and the render
// queue swallows that exception, so the item is left in edit mode with no
// editor behind it: the header says "Done", the addition side is
// contenteditable, and keystrokes go nowhere. Nothing later re-tries, because
// from Pierre's side the flag is already set.
//
// An immediate render costs one synchronous pass and starts from a clean
// slate, so it both closes that hole and removes the dependency on a frame
// ever arriving.
export function attachEditors(
  viewer: CodeViewHandle<Metadata> | null,
  editingFiles: ReadonlySet<string>,
): void {
  if (!viewer || editingFiles.size === 0) return
  const missing = () => [...editingFiles].some((name) => viewer.getEditor(name) == null)
  if (!missing()) return
  viewer.getInstance()?.render(true)
  if (!missing()) return
  // Two clean passes could not attach. Say so rather than leaving a header
  // that claims an edit session the user does not have.
  console.error(
    'krit: inline edit could not attach an editor for',
    [...editingFiles].filter((name) => viewer.getEditor(name) == null),
  )
}

// File change-type → short label. CodeView's FileDiffMetadata.type uses the
// patch-parser's vocabulary; we squash rename-pure/rename-changed since the
// distinction isn't useful at a glance.
function fileTypeLabel(type: FileDiffMetadata['type']): { label: string; cls: string } {
  switch (type) {
    case 'new':
      return { label: 'added', cls: 'pill-added' }
    case 'deleted':
      return { label: 'deleted', cls: 'pill-deleted' }
    case 'rename-pure':
    case 'rename-changed':
      return { label: 'renamed', cls: 'pill-renamed' }
    default:
      return { label: 'modified', cls: 'pill-modified' }
  }
}

export const CodeViewWrapper = memo(
  forwardRef<CodeViewWrapperHandle, Props>(function CodeViewWrapper(
    {
      files,
      diffStyle,
      defaultTabSize,
      viewedFiles,
      fileAnnotationsMap,
      commentCounts,
      fileStatsMap,
      onViewedChange,
      onAddComment,
      onDeleteComment,
      onReplyComment,
      onDeleteRange,
      onActiveFileChange,
      onEditFile,
      editingFiles,
      onToggleEdit,
      onEditComplete,
      staleFiles,
      onApplyStale,
      confirmSaveFiles,
      onCancelSaveConfirm,
      onActiveDraftsChange,
    },
    ref,
  ) {
    const viewerRef = useRef<CodeViewHandle<Metadata> | null>(null)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const [pending, setPending] = useState<Map<string, DraftMetadata>>(() => new Map())
    // Floating Comment/Delete pill for a native text selection inside the
    // code surface (Stage 6). null whenever there's no active selection to
    // show it for.
    const [textSelection, setTextSelection] = useState<{
      x: number
      y: number
      filePath: string
      side: AnnotationSide
      anchor: SelectionAnchor
    } | null>(null)
    const pillRef = useRef<HTMLDivElement | null>(null)

    const lastActiveDraftsRef = useRef<Set<string>>(new Set())
    useEffect(() => {
      const next = new Set([...pending.values()].map((d) => d.itemId))
      const prev = lastActiveDraftsRef.current
      const same = prev.size === next.size && [...prev].every((f) => next.has(f))
      if (same) return
      lastActiveDraftsRef.current = next
      onActiveDraftsChange?.(next)
    }, [pending, onActiveDraftsChange])

    const removeDraft = (key: string) => {
      setPending((prev) => {
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      })
    }

    // Per-keystroke updates from a draft's CommentForm. Deliberately mutates
    // the draft object in place instead of going through setPending: these
    // fields don't affect where the annotation renders, and a state update
    // here would ripple through the annotations effect into
    // viewer.updateItem() — which rebuilds the file's entire annotation DOM
    // on every keystroke, remounting every open form and bubble, stealing
    // focus to another form's mount-autofocus and snapping scroll to it.
    // The draft object is the same reference held by both the `pending` map
    // and the annotation metadata, so a real remount (structural refetch)
    // still seeds CommentForm with the freshest text via the initial* props.
    const updateDraft = (
      draft: DraftMetadata,
      patch: Partial<Pick<DraftMetadata, 'body' | 'suggestMode' | 'suggestionText'>>,
    ) => {
      Object.assign(draft, patch)
    }

    useImperativeHandle(
      ref,
      () => ({
        scrollToFile(filePath: string) {
          viewerRef.current?.scrollTo({
            type: 'item',
            id: filePath,
            align: 'start',
            behavior: 'smooth',
          })
        },
        applyExternalEdit(filePath: string, contents: string): boolean {
          // getEditor is typed as DiffsEditor, the narrow interface CodeView
          // needs; the document methods live on the concrete class. Probed
          // rather than asserted: this is a prerelease, and the declared
          // interface deliberately omits both methods, so if a later release
          // hands back something else we want the documented "no live editor"
          // answer — a diff refetch — not a TypeError mid-apply.
          const editor = viewerRef.current?.getEditor(filePath) as Editor<Metadata> | undefined
          if (typeof editor?.getText !== 'function' || typeof editor.applyEdits !== 'function') {
            return false
          }
          const edit = computeSingleEdit(editor.getText(), contents)
          // The write matched what's already in the document — an echo of the
          // session's own save, or a no-op touch. Reporting it as applied
          // keeps the caller from refetching the diff for nothing.
          if (!edit) return true
          editor.applyEdits([edit])
          return true
        },
        scrollToLine(filePath: string, side: SelectionSide, lineNumber: number) {
          // Expand if collapsed — scrolling to a line inside a collapsed file
          // would land on the (closed) header instead of the comment.
          const viewer = viewerRef.current
          if (!viewer) return
          const item = viewer.getItem(filePath)
          if (item?.type === 'diff' && item.collapsed) {
            item.collapsed = false
            item.version = bumpVersion(item)
            viewer.updateItem(item)
          }
          viewer.scrollTo({
            type: 'line',
            id: filePath,
            lineNumber,
            side,
            align: 'center',
            behavior: 'smooth',
          })
        },
      }),
      [],
    )

    const initialItems = useMemo<CodeViewItem<Metadata>[]>(
      () => buildItems(files, fileAnnotationsMap, pending, viewedFiles, fileStatsMap, editingFiles),
      // buildItems also reads fileAnnotationsMap, pending, viewedFiles,
      // fileStatsMap and editingFiles, and the omission is the point: these are
      // the items CodeView mounts with, and every later change to any of them
      // is owned by the sync effects below, which patch items in place. Adding
      // the deps would rebuild the initial list behind CodeView's back, where
      // nothing reads it again.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [files],
    )

    // App.tsx now memoizes `files` per file (see its fileCacheRef) — a file
    // whose patch fragment and bundled contents haven't changed keeps the
    // exact same FileDiffMetadata object across renders, so a plain
    // reference-equality check here is enough to tell what changed, no
    // per-file content serialization needed. A file whose identity changed
    // gets patched in place via `viewer.updateItem()` — replacing
    // item.fileDiff and bumping its version marks just that item's layout
    // dirty and re-renders it, without disturbing any other file's scroll
    // position, collapse state, or in-progress annotations. Only a change to
    // the *set* of files (one added or removed — e.g. a new untracked file
    // appears, or a revert drops one back to identical) forces a full
    // remount via `structuralRevision`: CodeViewHandle has no removeItem, so
    // shrinking the item list can't be done in place.
    const lastFileRef = useRef<Map<string, FileDiffMetadata> | null>(null)
    const pendingScrollRestoreRef = useRef<number | null>(null)
    // Set when a file-set change arrived while an edit session was open; the
    // remount it wanted is owed and runs once the last session closes.
    const pendingStructuralRef = useRef(false)
    const [structuralRevision, setStructuralRevision] = useState(0)
    useEffect(() => {
      const prevFiles = lastFileRef.current
      const nextFiles = new Map<string, FileDiffMetadata>()
      for (const file of files) nextFiles.set(file.name, file)

      if (prevFiles === null) {
        // First mount — initialItems already reflects `files`; nothing to patch.
        lastFileRef.current = nextFiles
        return
      }

      const sameFileSet =
        prevFiles.size === nextFiles.size && [...prevFiles.keys()].every((name) => nextFiles.has(name))

      if (!sameFileSet) {
        // The remount destroys every editor instance, and Pierre's teardown
        // path (reset() -> editor.cleanUp()) pushes no completion — unsaved
        // typing would go silently. An unrelated file appearing or vanishing
        // is not worth that, so hold the remount until the last session ends;
        // the effect below runs it then. Until then the item list is one file
        // stale, which is the same bargain live-unless-active already makes.
        if (editingFiles.size > 0) {
          pendingStructuralRef.current = true
          // Leave the baseline at prevFiles. A tick that adds or removes a file
          // can also change the contents of files present in both sets, and
          // those changes are skipped here along with the remount; advancing
          // the baseline would hide them from the next tick's
          // `prevFiles.get(name) !== nextFiles.get(name)` compare and leave
          // them rendering stale forever. The non-deferred branch can advance
          // safely because the remount rebuilds every item from `files`.
          return
        }
        lastFileRef.current = nextFiles
        pendingScrollRestoreRef.current = scrollRef.current?.scrollTop ?? null
        setStructuralRevision((r) => r + 1)
        return
      }

      lastFileRef.current = nextFiles
      syncItems(
        viewerRef.current,
        files,
        (name) => prevFiles.get(name) !== nextFiles.get(name),
        (item, name) => {
          const next = nextFiles.get(name)
          if (next) item.fileDiff = next
        },
      )
    }, [files])

    useLayoutEffect(() => {
      if (pendingScrollRestoreRef.current !== null && scrollRef.current) {
        scrollRef.current.scrollTop = pendingScrollRestoreRef.current
      }
      pendingScrollRestoreRef.current = null
    }, [structuralRevision])

    const lastAnnotationsRef = useRef<Map<string, DiffLineAnnotation<Metadata>[]>>(new Map())
    useEffect(() => {
      const merged = new Map<string, DiffLineAnnotation<Metadata>[]>()
      for (const file of files) {
        merged.set(
          file.name,
          mergeAnnotations(fileAnnotationsMap.get(file.name) ?? [], pending, file.name),
        )
      }
      syncItems(
        viewerRef.current,
        files,
        (name) => !annotationsEqual(lastAnnotationsRef.current.get(name), merged.get(name) ?? []),
        (item, name) => {
          const next = merged.get(name)
          if (!next) return
          item.annotations = next
          lastAnnotationsRef.current.set(name, next)
        },
      )
    }, [files, fileAnnotationsMap, pending])

    // Viewed-state changes drive two things: re-render the header (chevron +
    // checkbox + collapsed-state) and auto-collapse the file. We treat
    // "marked viewed" as a strong signal that the user is done with this file,
    // so we collapse it; un-viewing re-expands. Header re-renders unconditionally
    // for any viewed-toggle since renderHeaderPrefix reads viewedFiles via closure.
    const lastViewedRef = useRef<Set<string>>(new Set())
    useEffect(() => {
      const prev = lastViewedRef.current
      syncItems(
        viewerRef.current,
        files,
        (name) => prev.has(name) !== viewedFiles.has(name),
        (item, name) => {
          // Auto-collapse on viewed, auto-expand on un-viewed. The user can
          // still manually re-expand with the chevron after marking viewed.
          // Never collapse out from under a live editor: that would make
          // Pierre end the session and write the file, which is not what
          // ticking a checkbox asked for. syncItems still bumps the version,
          // so this suppresses only the collapse, not the header re-render.
          const after = viewedFiles.has(name)
          if (!(after && editingFiles.has(name))) item.collapsed = after
        },
      )
      lastViewedRef.current = new Set(viewedFiles)
    }, [files, viewedFiles])

    // Inline edit mode. Pierre ignores `edit` while an item is collapsed, so
    // entering edit mode also expands — otherwise the button would look dead
    // on a collapsed (viewed, or auto-collapsed) file.
    const lastEditingRef = useRef<Set<string>>(new Set())
    useEffect(() => {
      const prev = lastEditingRef.current
      syncItems(
        viewerRef.current,
        files,
        (name) => prev.has(name) !== editingFiles.has(name),
        (item, name) => {
          const after = editingFiles.has(name)
          item.edit = after
          if (after) item.collapsed = false
        },
      )
      lastEditingRef.current = new Set(editingFiles)
      attachEditors(viewerRef.current, editingFiles)
    }, [files, editingFiles])

    // Pay off a remount deferred by an open edit session (see above).
    useEffect(() => {
      if (editingFiles.size > 0 || !pendingStructuralRef.current) return
      pendingStructuralRef.current = false
      pendingScrollRestoreRef.current = scrollRef.current?.scrollTop ?? null
      setStructuralRevision((r) => r + 1)
    }, [editingFiles])

    // renderHeaderPrefix reads staleFiles and confirmSaveFiles through its
    // closure, so an item whose queued-change state moved needs a version bump
    // to re-run it and show (or drop) the Apply button and the save-anyway
    // question. Only files being edited render either, so only those need the
    // bump. The other order — one of these flipping first, edit second — is
    // covered by the edit effect above, which bumps unconditionally on entry;
    // this one handles movement while a session is already open.
    const lastEditHeaderRef = useRef<Map<string, string>>(new Map())
    useEffect(() => {
      const prev = lastEditHeaderRef.current
      const next = new Map<string, string>()
      for (const file of files) {
        next.set(file.name, `${staleFiles.has(file.name)}:${confirmSaveFiles.has(file.name)}`)
      }
      syncItems(
        viewerRef.current,
        files,
        (name) => editingFiles.has(name) && prev.get(name) !== next.get(name),
      )
      lastEditHeaderRef.current = next
    }, [files, staleFiles, confirmSaveFiles, editingFiles])

    // Push comment-count changes into header metadata. We bump version for
    // any file whose count changed so renderHeaderMetadata re-runs.
    const lastCountsRef = useRef<Record<string, number>>({})
    useEffect(() => {
      const prev = lastCountsRef.current
      syncItems(
        viewerRef.current,
        files,
        (name) => (prev[name] ?? 0) !== (commentCounts[name] ?? 0),
      )
      lastCountsRef.current = commentCounts
    }, [files, commentCounts])

    // Same idea for stats: bump version if a file's stats change so the
    // metadata cell rerenders. In practice stats don't change for a given diff
    // identity — a change to the file set remounts via `structuralRevision`,
    // and a mode switch remounts via App's key on DiffViewer — but this keeps
    // the data path consistent.
    const lastStatsRef = useRef<Record<string, { additions: number; deletions: number }>>({})
    useEffect(() => {
      const prev = lastStatsRef.current
      syncItems(viewerRef.current, files, (name) => {
        const a = prev[name]
        const b = fileStatsMap[name]
        return a?.additions !== b?.additions || a?.deletions !== b?.deletions
      })
      lastStatsRef.current = fileStatsMap
    }, [files, fileStatsMap])

    // Track whether the user is mid-drag (line selection or gutter-utility
    // selection). onLineEnter fires per-line during the drag, and we must
    // NOT clear the selection while it's still being built — that would wipe
    // every range the moment the cursor crossed a fresh line.
    const isSelectingRef = useRef(false)

    // Last line the pointer hovered, including which side (additions vs
    // deletions) — Pierre's InteractionManager tracks this internally and
    // hands it to onLineEnter, so it's a reliable signal for which side a
    // text selection's end line belongs to (there's no side attribute on
    // the rendered DOM we can inspect ourselves; see selectionMapping.ts).
    const lastHoveredRef = useRef<{ filePath: string; lineNumber: number; side: AnnotationSide } | null>(null)

    // Where the current drag began, in viewport coordinates. The anchor is
    // hit-tested from the drag's two endpoints, and mouseup only carries one
    // of them.
    const dragStartRef = useRef<DragPoint | null>(null)

    // Clear the lib's line selection when the user hovers a line outside the
    // currently selected range. See the enableLineSelection comment in the
    // options block for the why.
    const handleLineEnter = useStableCallback(
      (
        props: { lineNumber: number; annotationSide?: AnnotationSide },
        ctx: { item: CodeViewItem<Metadata> },
      ) => {
        if (ctx?.item?.type === 'diff') {
          lastHoveredRef.current = {
            filePath: ctx.item.id,
            lineNumber: props.lineNumber,
            side: props.annotationSide ?? 'additions',
          }
        }
        if (isSelectingRef.current) return
        const viewer = viewerRef.current
        if (!viewer || !ctx?.item) return
        const sel = viewer.getSelectedLines()
        if (!sel) return
        if (sel.id !== ctx.item.id) {
          viewer.clearSelectedLines()
          return
        }
        const lo = Math.min(sel.range.start, sel.range.end)
        const hi = Math.max(sel.range.start, sel.range.end)
        if (props.lineNumber < lo || props.lineNumber > hi) viewer.clearSelectedLines()
      },
    )

    const handleGutterClick = useStableCallback(
      (
        range: SelectedLineRange,
        context: { item: CodeViewItem<Metadata> },
      ) => {
        if (context.item.type !== 'diff') return
        // Pick whichever side the drag ended on; if neither is set (rare —
        // typically only on synthetic events), fall back to additions since
        // that's where reviewers comment the vast majority of the time. We
        // do NOT bail on cross-side ranges: in split view the + button is
        // anchored on one column (often deletions) while the coordinate-
        // resolved drag endpoint lands on whichever column the cursor is in.
        // Cross-side just means "started here, ended there" — commit to one.
        const side = range.endSide ?? range.side ?? 'additions'
        const startLine = Math.min(range.start, range.end)
        const endLine = Math.max(range.start, range.end)
        const draft: DraftMetadata = {
          _pending: true,
          itemId: context.item.id,
          side,
          startLine,
          endLine,
          body: '',
          suggestMode: false,
          // Seeded with the original lines up front (rather than left '' and
          // falling back via `??` in CommentForm) so an empty-string edit —
          // the user selects all and deletes — round-trips correctly instead
          // of being indistinguishable from "never touched."
          suggestionText: getRangeContent(context.item.fileDiff, side, startLine, endLine),
        }
        const key = draftKey(draft)
        // No-op if the user already has a draft open on this exact range;
        // CodeView's gutter handler can fire repeatedly on the same selection.
        if (pending.has(key)) return
        setPending((prev) => {
          const next = new Map(prev)
          next.set(key, draft)
          return next
        })
      },
    )

    // Text drag over the code surface -> floating Comment/Delete pill
    // (Stage 6). Listens on scrollRef (the same element handed to CodeView as
    // containerRef) rather than document, since mouse events are composed and
    // bubble out through the open shadow root to any light-DOM ancestor
    // listener. At a light-DOM listener `e.target` is retargeted to the shadow
    // *host*, whose root node is the document; composedPath()[0] is the
    // untargeted deep node and is what identifies the right shadow root.
    //
    // The anchor comes from the drag's own coordinates — mousedown's and
    // mouseup's — hit-tested by the browser, rather than from the Selection
    // API, whose shadow-piercing form differs per engine (see
    // selectionMapping.ts). Both endpoints are therefore ours to keep.
    useEffect(() => {
      const container = scrollRef.current
      if (!container) return
      const handleMouseDown = (e: MouseEvent) => {
        // composedPath() must be read synchronously — after dispatch
        // completes it returns [], per spec. The deep target is kept so the
        // drag's two ends can be checked for being in the same file.
        dragStartRef.current = { x: e.clientX, y: e.clientY, target: e.composedPath()[0] ?? e.target }
      }
      const handleMouseUp = (e: MouseEvent) => {
        const start = dragStartRef.current
        dragStartRef.current = null
        if (!start) return
        const deepTarget = e.composedPath()[0] ?? e.target
        // A double- or triple-click selects without moving the pointer, so the
        // drag path would see a collapsed range and decline. The reviewer can
        // see the browser's highlight either way and expects to act on it.
        const range =
          e.detail >= 2
            ? rangeFromClick({ x: e.clientX, y: e.clientY }, deepTarget, e.detail)
            : rangeFromDragPoints(start, { x: e.clientX, y: e.clientY }, deepTarget)
        if (!range) return
        const anchor = mapRangeToAnchor(range)
        if (!anchor) return
        const hovered = lastHoveredRef.current
        // onLineEnter (which populates lastHoveredRef) only fires when
        // the pointer *crosses into* a line. Right after a per-file
        // remount (e.g. a delete's file-changed refetch) the pointer can
        // already be resting inside the line the user is about to drag
        // over, so onLineEnter never re-fires and hovered is stale null
        // -- bailing here made the pill flaky on exactly that first
        // drag. Fall back to the scroll-tracked "active" file (already
        // maintained independent of hover, see handleScroll below) with
        // side defaulting to 'additions', the same fallback used
        // elsewhere in this file (handleGutterClick) when the side can't
        // be determined precisely -- an imprecise guess beats no pill at
        // all, and this path is only reached when hover tracking hasn't
        // caught up yet.
        const filePath = hovered?.filePath ?? lastActiveFileRef.current
        if (!filePath) return
        const side = hovered?.side ?? 'additions'
        const rect = range.getBoundingClientRect()
        setTextSelection({
          x: rect.right,
          y: rect.bottom + 6,
          filePath,
          side,
          anchor,
        })
      }
      container.addEventListener('mousedown', handleMouseDown)
      container.addEventListener('mouseup', handleMouseUp)
      return () => {
        container.removeEventListener('mousedown', handleMouseDown)
        container.removeEventListener('mouseup', handleMouseUp)
      }
    }, [])

    // Dismiss the pill on Escape or a click outside it. Clicking the pill's
    // own buttons is a mousedown too, so exclude anything inside pillRef —
    // SelectionPill itself also preventDefault()s its own mousedown to keep
    // the underlying text selection intact until the button's onClick reads it.
    useEffect(() => {
      if (!textSelection) return
      const handleDocMouseDown = (e: MouseEvent) => {
        const path = e.composedPath()
        if (pillRef.current && path.includes(pillRef.current)) return
        setTextSelection(null)
      }
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setTextSelection(null)
      }
      document.addEventListener('mousedown', handleDocMouseDown)
      document.addEventListener('keydown', handleKeyDown)
      return () => {
        document.removeEventListener('mousedown', handleDocMouseDown)
        document.removeEventListener('keydown', handleKeyDown)
      }
    }, [textSelection])

    const handlePillComment = () => {
      if (!textSelection) return
      const { filePath, side, anchor } = textSelection
      const draft: DraftMetadata = {
        _pending: true,
        itemId: filePath,
        side,
        startLine: anchor.startLine,
        endLine: anchor.endLine,
        body: '',
        suggestMode: false,
        suggestionText: anchor.selectedText,
        charAnchor: {
          startColumn: anchor.startColumn,
          endColumn: anchor.endColumn,
          selectedText: anchor.selectedText,
        },
      }
      const key = draftKey(draft)
      if (!pending.has(key)) {
        setPending((prev) => new Map(prev).set(key, draft))
      }
      setTextSelection(null)
    }

    const handlePillDelete = () => {
      if (!textSelection) return
      onDeleteRange?.(textSelection.filePath, textSelection.anchor)
      setTextSelection(null)
    }

    const renderAnnotation = useStableCallback(
      (
        annotation: DiffLineAnnotation<Metadata>,
        item: CodeViewItem<Metadata>,
      ) => {
        if (item.type !== 'diff') return null
        if ('_pending' in annotation.metadata) {
          const p = annotation.metadata
          const rangeLabel = p.charAnchor
            ? `Commenting on "${truncateForLabel(p.charAnchor.selectedText)}"`
            : p.endLine > p.startLine
              ? `Commenting on lines ${p.startLine}–${p.endLine}`
              : null
          // A character-anchored draft's "original" for suggest-edit diffing
          // purposes is the exact selected substring, not the full line(s) —
          // otherwise CommentForm's "did the user actually change it" check
          // (suggestionText !== originalLines) would be true from the start,
          // since the CM editor is seeded with just the selection.
          const originalLines = p.charAnchor
            ? p.charAnchor.selectedText
            : getRangeContent(item.fileDiff, p.side, p.startLine, p.endLine)
          return (
            <AnnotationEventGuard>
              {rangeLabel && <div className="comment-range-label">{rangeLabel}</div>}
              <CommentForm
                filePath={item.fileDiff.name}
                originalLines={originalLines}
                initialBody={p.body}
                initialSuggestMode={p.suggestMode}
                initialSuggestionText={p.suggestionText}
                onBodyChange={(body) => updateDraft(p, { body })}
                onSuggestModeChange={(suggestMode) => updateDraft(p, { suggestMode })}
                onSuggestionTextChange={(suggestionText) => updateDraft(p, { suggestionText })}
                onSubmit={(body, suggestion) => {
                  const lineContent = getRangeContent(
                    item.fileDiff,
                    p.side,
                    p.startLine,
                    p.endLine,
                  )
                  onAddComment(
                    p.itemId,
                    p.side,
                    p.startLine,
                    p.endLine,
                    lineContent,
                    body,
                    suggestion,
                    false,
                    p.charAnchor,
                  )
                  removeDraft(draftKey(p))
                }}
                onSaveDraft={(body, suggestion) => {
                  const lineContent = getRangeContent(
                    item.fileDiff,
                    p.side,
                    p.startLine,
                    p.endLine,
                  )
                  onAddComment(
                    p.itemId,
                    p.side,
                    p.startLine,
                    p.endLine,
                    lineContent,
                    body,
                    suggestion,
                    true,
                    p.charAnchor,
                  )
                  removeDraft(draftKey(p))
                }}
                onCancel={() => removeDraft(draftKey(p))}
              />
            </AnnotationEventGuard>
          )
        }
        return (
          <AnnotationEventGuard>
            <CommentBubble
              comment={annotation.metadata as ReviewComment}
              onDelete={onDeleteComment}
              onReply={onReplyComment}
            />
          </AnnotationEventGuard>
        )
      },
    )

    // Collapsing ends a Pierre edit session (it fires onItemEditComplete for
    // "edit turned off, item removed or collapsed"), which writes the file.
    // Route it through the normal exit so the save is the one the user gets
    // asked about and our `editingFiles` doesn't outlive the session Pierre
    // just closed — otherwise the header keeps reading "Done" over a dead
    // editor and useDiff defers that file's changes forever.
    const handleToggleCollapse = useStableCallback((itemId: string) => {
      const viewer = viewerRef.current
      if (!viewer) return
      const item = viewer.getItem(itemId)
      if (!item || item.type !== 'diff') return
      const collapsing = item.collapsed !== true
      if (collapsing && editingFiles.has(itemId)) {
        onToggleEdit(itemId)
        return
      }
      item.collapsed = collapsing
      item.version = bumpVersion(item)
      viewer.updateItem(item)
    })

    const renderHeaderPrefix = useStableCallback(
      (item: CodeViewItem<Metadata>) => {
        if (item.type !== 'diff') return null
        const viewed = viewedFiles.has(item.id)
        const editing = editingFiles.has(item.id)
        const stale = staleFiles.has(item.id)
        const confirmingSave = editing && confirmSaveFiles.has(item.id)
        const empty =
          item.fileDiff.splitLineCount === 0 && item.fileDiff.unifiedLineCount === 0
        return (
          <div className="codeview-header-prefix">
            <button
              type="button"
              className="codeview-collapse-btn"
              disabled={empty}
              aria-expanded={!item.collapsed}
              aria-label={item.collapsed ? 'Expand diff' : 'Collapse diff'}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                handleToggleCollapse(item.id)
              }}
            >
              <span className={`chevron ${item.collapsed ? '' : 'chevron-down'}`}>›</span>
            </button>
            <label
              className="viewed-label"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={viewed}
                onChange={(e) => onViewedChange(item.id, e.target.checked)}
              />
              Viewed
            </label>
            <button
              type="button"
              className={`codeview-edit-btn ${editing ? 'is-editing' : ''}`}
              title={editing ? 'Finish editing and save' : 'Edit this file inline'}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onToggleEdit(item.id)
              }}
            >
              {editing ? 'Done' : 'Edit'}
            </button>
            {editing && stale && (
              <button
                type="button"
                className="codeview-stale-btn"
                title="This file changed on disk while you were editing. Apply the change as one undoable edit."
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onApplyStale(item.id)
                }}
              >
                ⚠ changed on disk — Apply
              </button>
            )}
            {confirmingSave && (
              <span className="codeview-confirm-save" role="alert">
                Save over it?
                <button
                  type="button"
                  className="codeview-confirm-save-btn"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    // Second Done — App reads the pending question as the
                    // answer and lets the save through.
                    onToggleEdit(item.id)
                  }}
                >
                  Save anyway
                </button>
                <button
                  type="button"
                  className="codeview-confirm-save-btn"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onCancelSaveConfirm(item.id)
                  }}
                >
                  Keep editing
                </button>
              </span>
            )}
            {onEditFile && !editing && (
              <button
                type="button"
                className="codeview-edit-btn codeview-edit-btn-secondary"
                // The inline editor only covers what the diff renders; this
                // opens the whole file, including untouched regions.
                title="Edit whole file in a modal"
                aria-label="Edit whole file in a modal"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onEditFile(item.id)
                }}
              >
                ⤢
              </button>
            )}
          </div>
        )
      },
    )

    const renderHeaderMetadata = useStableCallback(
      (item: CodeViewItem<Metadata>) => {
        if (item.type !== 'diff') return null
        const { label, cls } = fileTypeLabel(item.fileDiff.type)
        const stats = fileStatsMap[item.id]
        const additions = stats?.additions ?? 0
        const deletions = stats?.deletions ?? 0
        const count = commentCounts[item.id] ?? 0
        return (
          <div className="codeview-header-meta">
            <span className={`cv-pill ${cls}`}>{label}</span>
            {additions > 0 && <span className="cv-stat cv-add">+{additions}</span>}
            {deletions > 0 && <span className="cv-stat cv-del">−{deletions}</span>}
            {count > 0 && (
              <span className="cv-stat cv-comments" title={`${count} comment${count === 1 ? '' : 's'}`}>
                💬 {count}
              </span>
            )}
          </div>
        )
      },
    )

    // Live surface geometry, remeasured whenever the thing that sets it moves:
    // the container resizes (window, sidebar toggle, split/unified column
    // width) or a remount repaints the surface. Held as state because
    // `options.itemMetrics` is derived from it and CodeView must see the new
    // value; Pierre reanchors scroll across the relayout itself.
    const [surfaceMetrics, setSurfaceMetrics] = useState<SurfaceMetrics | null>(null)
    // Header reservation only ever grows. The tall header belongs to whichever
    // file is mid-edit, so letting the metric fall back the moment that file
    // leaves edit mode would shorten the layout under a user who is still
    // scrolling it.
    const maxHeaderHeightRef = useRef(0)
    const measureFrameRef = useRef<number | null>(null)
    const scheduleMeasure = useStableCallback((attemptsLeft = MEASURE_ATTEMPTS) => {
      if (measureFrameRef.current !== null) return
      measureFrameRef.current = requestAnimationFrame(() => {
        measureFrameRef.current = null
        const next = measureSurfaceMetrics(scrollRef.current)
        if (!next) {
          // CodeView paints asynchronously after mount, so the first attempts
          // legitimately find nothing. Bounded rather than open-ended: a diff
          // with no files renders no surface and would otherwise leave a
          // retry running for the life of the page.
          if (attemptsLeft > 0) scheduleMeasure(attemptsLeft - 1)
          return
        }
        maxHeaderHeightRef.current = Math.max(maxHeaderHeightRef.current, next.headerHeight)
        next.headerHeight = maxHeaderHeightRef.current
        setSurfaceMetrics((prev) =>
          prev &&
          prev.rowHeight === next.rowHeight &&
          prev.charsPerRow === next.charsPerRow &&
          prev.headerHeight === next.headerHeight
            ? prev
            : next,
        )
      })
    })

    useEffect(() => {
      const container = scrollRef.current
      if (!container) return
      scheduleMeasure()
      const observer = new ResizeObserver(() => scheduleMeasure())
      observer.observe(container)
      return () => {
        observer.disconnect()
        if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current)
        measureFrameRef.current = null
      }
    }, [structuralRevision, scheduleMeasure])

    // The header renderers grow and shrink with these, and Pierre reserves one
    // height for every header — so a change here can change what the tallest
    // header is. The resize observer above doesn't see it: the container's own
    // size never moves.
    useEffect(() => {
      scheduleMeasure()
    }, [editingFiles, staleFiles, confirmSaveFiles, diffStyle, scheduleMeasure])

    const itemMetrics = useMemo(() => {
      if (!surfaceMetrics) return undefined
      return {
        lineHeight: estimateWrappedRowHeight(files, surfaceMetrics),
        diffHeaderHeight: surfaceMetrics.headerHeight,
      }
    }, [files, surfaceMetrics])

    const activeOffset = 80
    const lastActiveFileRef = useRef<string | null>(null)
    const rafIdRef = useRef<number | null>(null)
    const handleScroll = useStableCallback((scrollTop: number) => {
      if (!onActiveFileChange) return
      if (rafIdRef.current != null) return
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null
        const instance = viewerRef.current?.getInstance()
        if (!instance) return
        let active: string | null = null
        let bestTop = -Infinity
        for (const file of files) {
          const top = instance.getTopForItem(file.name)
          if (top == null) continue
          if (top <= scrollTop + activeOffset && top > bestTop) {
            bestTop = top
            active = file.name
          }
        }
        if (active !== lastActiveFileRef.current) {
          lastActiveFileRef.current = active
          onActiveFileChange(active)
        }
      })
    })

    const options: CodeViewOptions<Metadata> = useMemo(
      () => ({
        diffStyle,
        // Wrap long lines instead of clipping them — the surface has
        // overflow-x: clip (global.css), so anything past the viewport edge
        // was simply unreadable.
        overflow: 'wrap' as const,
        // Pierre's default metrics assume one 20px row per source line and a
        // 44px header. Both under-reserve here — wrapped lines occupy several
        // rows, and krit's header prefix can outgrow one row — and an
        // under-reserved layout grows as rows are measured on approach, so the
        // bottom of the scroll recedes and never arrives. Measured, so a theme
        // change moves it too. Undefined until the surface has painted once;
        // Pierre reanchors scroll when it lands.
        itemMetrics,
        themeType: 'system' as const,
        theme: { dark: 'github-dark' as const, light: 'github-light' as const },
        enableGutterUtility: true,
        // Line selection is on (so drag-to-select-range works visually), but
        // we auto-clear the selection in onLineEnter when the user hovers a
        // line outside the selected range. Without that clear, the lib glues
        // the '+' button to the most recently clicked line and ignores
        // subsequent hovers — users hover line Y, press where the '+' looks
        // like it should be, but pointerdown lands on empty gutter and the
        // lib starts a line-select drag instead of a gutter-utility drag, so
        // no comment form opens. Clearing on hover-away restores the
        // "+ tracks hover" behavior while preserving in-drag visualization.
        enableLineSelection: true,
        stickyHeaders: true,
        lineHoverHighlight: 'number' as const,
        // Tab size + inverse-sticky shadow. The @container scroll-state trick
        // (cribbed from diffshub) only paints the hairline under a header when
        // it's *actually stuck* at the top — much quieter than always-on.
        unsafeCSS: `
          :host { --diffs-tab-size: ${defaultTabSize}; }
          [data-diffs-header] {
            container-type: scroll-state;
            container-name: krit-sticky-header;
          }
          @container krit-sticky-header scroll-state(stuck: top) {
            [data-diffs-header]::after {
              position: absolute;
              bottom: -1px;
              left: 0;
              width: 100%;
              height: 1px;
              content: '';
              background-color: var(--color-border-opaque, currentColor);
              opacity: 0.4;
            }
          }
        `,
        onGutterUtilityClick: (range, context) => handleGutterClick(range, context),
        // Lib wraps onLineEnter via defineItemSharedCallback to inject a
        // second arg {item}. The cast keeps us in lockstep with that shape.
        onLineEnter: ((props: unknown, ctx: unknown) =>
          handleLineEnter(
            props as { lineNumber: number; annotationSide?: AnnotationSide },
            ctx as { item: CodeViewItem<Metadata> },
          )) as never,
        // Mid-drag the user is still building their selection; the auto-clear
        // in onLineEnter would otherwise wipe each newly-crossed line.
        onLineSelectionStart: () => {
          isSelectingRef.current = true
        },
        onLineSelectionEnd: () => {
          isSelectingRef.current = false
        },
      }),
      [diffStyle, defaultTabSize, itemMetrics, handleGutterClick, handleLineEnter],
    )

    // One factory for every inline edit session. CodeView calls it per item
    // and supplies that item's `onChange`, so our defaults must not include
    // one. `persistState` stays off: it keys documents by `cacheKey`, and
    // ours changes on every refetch (contents changed => new key, by the
    // library's own contract), so there is nothing stable to persist against.
    const createEditor = useStableCallback((editorOptions: EditorOptions<Metadata>) => {
      return new Editor<Metadata>({
        matchBrackets: true,
        roundedSelection: true,
        ...editorOptions,
      })
    })

    // Pierre's documented commit path is one immediate updateItem carrying the
    // new fileDiff and a fresh cacheKey. We deliberately don't: the diff shown
    // is the server's, and re-deriving a FileDiffMetadata client-side from the
    // editor's text would mean rendering a diff the server never computed.
    // Writing and letting file-written drive the refetch keeps one source of
    // truth, at the cost of a brief window where the item still holds the
    // pre-edit fileDiff.
    const handleItemEditComplete = useStableCallback(
      (item: CodeViewItem<Metadata>, file: { contents: string }) => {
        onEditComplete(item.id, file.contents)
      },
    )

    return (
      <EditProvider<Metadata> createEditor={createEditor}>
        <CodeView<Metadata>
          key={structuralRevision}
          ref={(v) => {
            viewerRef.current = v
          }}
          containerRef={scrollRef}
          initialItems={initialItems}
          options={options}
          onScroll={handleScroll}
          onItemEditComplete={handleItemEditComplete}
          renderAnnotation={renderAnnotation}
          renderHeaderPrefix={renderHeaderPrefix}
          renderHeaderMetadata={renderHeaderMetadata}
          className="codeview-surface"
        />
        {textSelection && (
          <div ref={pillRef}>
            <SelectionPill
              x={textSelection.x}
              y={textSelection.y}
              onComment={handlePillComment}
              onDelete={handlePillDelete}
            />
          </div>
        )}
      </EditProvider>
    )
  }),
)

function buildItems(
  files: FileDiffMetadata[],
  fileAnnotationsMap: Map<string, DiffLineAnnotation<ReviewComment>[]>,
  pending: Map<string, DraftMetadata>,
  viewedFiles: Set<string>,
  fileStatsMap: Record<string, { additions: number; deletions: number }>,
  editingFiles: Set<string>,
): CodeViewItem<Metadata>[] {
  return files.map((fileDiff) => {
    const stats = fileStatsMap[fileDiff.name]
    const changeCount = (stats?.additions ?? 0) + (stats?.deletions ?? 0)
    // Initial collapse: viewed files (carryover from a prior session) and
    // very large diffs. Manual chevron toggle still overrides.
    const editing = editingFiles.has(fileDiff.name)
    const collapsed =
      !editing && (viewedFiles.has(fileDiff.name) || changeCount > AUTO_COLLAPSE_CHANGE_THRESHOLD)
    return {
      id: fileDiff.name,
      type: 'diff' as const,
      fileDiff,
      collapsed,
      edit: editing,
      annotations: mergeAnnotations(
        fileAnnotationsMap.get(fileDiff.name) ?? [],
        pending,
        fileDiff.name,
      ),
      version: 0,
    }
  })
}

function mergeAnnotations(
  persisted: DiffLineAnnotation<ReviewComment>[],
  pending: Map<string, DraftMetadata>,
  fileName: string,
): DiffLineAnnotation<Metadata>[] {
  if (pending.size === 0) return persisted
  const drafts: DiffLineAnnotation<Metadata>[] = []
  for (const d of pending.values()) {
    if (d.itemId !== fileName) continue
    drafts.push({ side: d.side, lineNumber: d.endLine, metadata: d })
  }
  if (drafts.length === 0) return persisted
  return [...persisted, ...drafts]
}

function annotationsEqual(
  a: DiffLineAnnotation<Metadata>[] | undefined,
  b: DiffLineAnnotation<Metadata>[],
): boolean {
  if (a === b) return true
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].metadata !== b[i].metadata) return false
    if (a[i].lineNumber !== b[i].lineNumber) return false
    if (a[i].side !== b[i].side) return false
  }
  return true
}
