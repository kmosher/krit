import { useState, useRef, useMemo, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, memo } from 'react'
import { CodeView, useStableCallback, type CodeViewHandle } from '@pierre/diffs/react'
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
import { getActiveSelectionRange, mapRangeToAnchor, type SelectionAnchor } from '../utils/selectionMapping'

type DraftMetadata = {
  _pending: true
  itemId: string
  side: AnnotationSide
  startLine: number
  endLine: number
  // In-progress form text, lifted out of CommentForm's local state so a
  // remount (structural file add/remove, or a page reload once Stage 8
  // persists drafts) doesn't discard what the user was typing.
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

export interface CodeViewWrapperHandle {
  scrollToFile(filePath: string): void
  scrollToLine(filePath: string, side: SelectionSide, lineNumber: number): void
}

interface Props {
  files: FileDiffMetadata[]
  diffStyle: 'split' | 'unified'
  defaultTabSize: number
  viewedFiles: Set<string>
  fileAnnotationsMap: Map<string, DiffLineAnnotation<ReviewComment>[]>
  commentCounts: Record<string, number>
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
  onEditFile?(filePath: string): void
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

// Cheap identity for "did this file's diff content actually change" across a
// refetch, since every FileDiffMetadata is a fresh object per parse. `hunks`
// only carries line ranges/offsets — for a full-file (isPartial:false) diff
// the actual line text lives in additionLines/deletionLines, so a signature
// built from hunks alone misses every edit that doesn't shift line counts
// (e.g. rewording a single line).
function fileContentSignature(file: FileDiffMetadata): string {
  return JSON.stringify([
    file.hunks,
    file.additionLines,
    file.deletionLines,
    file.type,
    file.prevName,
    file.splitLineCount,
    file.unifiedLineCount,
    file.isPartial,
  ])
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

// We can't rely on hunk.additionLines/deletionLines after the parseDiffFromFile
// upgrade — that path returns hunks with zero +/- counts (the upgrade is for
// expansion context, not stats). Counting from FileDiffMetadata.additionLines
// (the array of strings) is wrong too: in full-file mode it's the entire new
// file. So we hand stats in from the caller, computed off the patch text.

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

    // Per-keystroke updates from a draft's CommentForm. Cheap Map copy — draft
    // counts are always small (one open form per line range a reviewer is
    // actively commenting on).
    const updateDraft = (key: string, patch: Partial<Pick<DraftMetadata, 'body' | 'suggestMode' | 'suggestionText'>>) => {
      setPending((prev) => {
        const existing = prev.get(key)
        if (!existing) return prev
        const next = new Map(prev)
        next.set(key, { ...existing, ...patch })
        return next
      })
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
      () => buildItems(files, fileAnnotationsMap, pending, viewedFiles, fileStatsMap),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [files],
    )

    // `files` is re-parsed from scratch on every diff refetch (see App.tsx),
    // so every FileDiffMetadata is a brand-new object even when its content
    // is unchanged — reference equality can't tell us what actually changed.
    // A file whose content signature changed gets patched in place via
    // `viewer.updateItem()` — replacing item.fileDiff and bumping its version
    // marks just that item's layout dirty and re-renders it, without
    // disturbing any other file's scroll position, collapse state, or
    // in-progress annotations. Only a change to the *set* of files (one
    // added or removed — e.g. a new untracked file appears, or a revert
    // drops one back to identical) forces a full remount via
    // `structuralRevision`: CodeViewHandle has no removeItem, so shrinking
    // the item list can't be done in place.
    const lastFileSigRef = useRef<Map<string, string> | null>(null)
    const pendingScrollRestoreRef = useRef<number | null>(null)
    const [structuralRevision, setStructuralRevision] = useState(0)
    useEffect(() => {
      const prevSig = lastFileSigRef.current
      const nextSig = new Map<string, string>()
      for (const file of files) nextSig.set(file.name, fileContentSignature(file))

      if (prevSig === null) {
        // First mount — initialItems already reflects `files`; nothing to patch.
        lastFileSigRef.current = nextSig
        return
      }

      const sameFileSet =
        prevSig.size === nextSig.size && [...prevSig.keys()].every((name) => nextSig.has(name))
      lastFileSigRef.current = nextSig

      if (!sameFileSet) {
        pendingScrollRestoreRef.current = scrollRef.current?.scrollTop ?? null
        setStructuralRevision((r) => r + 1)
        return
      }

      const viewer = viewerRef.current
      if (!viewer) return
      for (const file of files) {
        if (prevSig.get(file.name) === nextSig.get(file.name)) continue
        const item = viewer.getItem(file.name)
        if (!item || item.type !== 'diff') continue
        item.fileDiff = file
        item.version = bumpVersion(item)
        viewer.updateItem(item)
      }
    }, [files])

    useLayoutEffect(() => {
      if (pendingScrollRestoreRef.current !== null && scrollRef.current) {
        scrollRef.current.scrollTop = pendingScrollRestoreRef.current
      }
      pendingScrollRestoreRef.current = null
    }, [structuralRevision])

    const lastAnnotationsRef = useRef<Map<string, DiffLineAnnotation<Metadata>[]>>(new Map())
    useEffect(() => {
      const viewer = viewerRef.current
      if (!viewer) return
      for (const file of files) {
        const next = mergeAnnotations(fileAnnotationsMap.get(file.name) ?? [], pending, file.name)
        const prev = lastAnnotationsRef.current.get(file.name)
        if (annotationsEqual(prev, next)) continue
        const item = viewer.getItem(file.name)
        if (!item || item.type !== 'diff') continue
        item.annotations = next
        item.version = bumpVersion(item)
        viewer.updateItem(item)
        lastAnnotationsRef.current.set(file.name, next)
      }
    }, [files, fileAnnotationsMap, pending])

    // Viewed-state changes drive two things: re-render the header (chevron +
    // checkbox + collapsed-state) and auto-collapse the file. We treat
    // "marked viewed" as a strong signal that the user is done with this file,
    // so we collapse it; un-viewing re-expands. Header re-renders unconditionally
    // for any viewed-toggle since renderHeaderPrefix reads viewedFiles via closure.
    const lastViewedRef = useRef<Set<string>>(new Set())
    useEffect(() => {
      const viewer = viewerRef.current
      if (!viewer) return
      const prev = lastViewedRef.current
      const next = viewedFiles
      for (const file of files) {
        const before = prev.has(file.name)
        const after = next.has(file.name)
        if (before === after) continue
        const item = viewer.getItem(file.name)
        if (!item || item.type !== 'diff') continue
        // Auto-collapse on viewed, auto-expand on un-viewed. The user can
        // still manually re-expand with the chevron after marking viewed.
        item.collapsed = after
        item.version = bumpVersion(item)
        viewer.updateItem(item)
      }
      lastViewedRef.current = new Set(next)
    }, [files, viewedFiles])

    // Push comment-count changes into header metadata. We bump version for
    // any file whose count changed so renderHeaderMetadata re-runs.
    const lastCountsRef = useRef<Record<string, number>>({})
    useEffect(() => {
      const viewer = viewerRef.current
      if (!viewer) return
      const prev = lastCountsRef.current
      for (const file of files) {
        const before = prev[file.name] ?? 0
        const after = commentCounts[file.name] ?? 0
        if (before === after) continue
        const item = viewer.getItem(file.name)
        if (!item || item.type !== 'diff') continue
        item.version = bumpVersion(item)
        viewer.updateItem(item)
      }
      lastCountsRef.current = commentCounts
    }, [files, commentCounts])

    // Same idea for stats: bump version if a file's stats change so the
    // metadata cell rerenders. In practice stats don't change for a given
    // diff identity (the viewerKey remount catches identity changes), but
    // this keeps the data path consistent.
    const lastStatsRef = useRef<Record<string, { additions: number; deletions: number }>>({})
    useEffect(() => {
      const viewer = viewerRef.current
      if (!viewer) return
      const prev = lastStatsRef.current
      for (const file of files) {
        const a = prev[file.name]
        const b = fileStatsMap[file.name]
        if (a?.additions === b?.additions && a?.deletions === b?.deletions) continue
        const item = viewer.getItem(file.name)
        if (!item || item.type !== 'diff') continue
        item.version = bumpVersion(item)
        viewer.updateItem(item)
      }
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

    // Native text selection inside the code surface -> floating
    // Comment/Delete pill (Stage 6). Listens on scrollRef (the same element
    // handed to CodeView as containerRef) rather than document, since
    // mouseup is a composed event and bubbles out through an open shadow
    // root to any light-DOM ancestor listener -- we don't need
    // composedPath() gymnastics for *this* listener, only for reading the
    // selection itself (see selectionMapping.ts).
    useEffect(() => {
      const container = scrollRef.current
      if (!container) return
      const handleMouseUp = (e: MouseEvent) => {
        // requestAnimationFrame: on mouseup the browser hasn't always
        // finished finalizing the Selection object yet (most visible in
        // Chrome on a fast double-click-drag); reading it a tick later is
        // more reliable than reading synchronously in the handler.
        requestAnimationFrame(() => {
          const range = getActiveSelectionRange(e.target)
          if (!range) return
          const anchor = mapRangeToAnchor(range)
          if (!anchor) return
          const hovered = lastHoveredRef.current
          // Without a known hovered line we don't have a reliable file/side
          // to anchor the comment to -- skip rather than guess. In practice
          // the pointer has always crossed a line (firing onLineEnter)
          // before a mouseup could end a same-surface drag.
          if (!hovered) return
          const rect = range.getBoundingClientRect()
          setTextSelection({
            x: rect.right,
            y: rect.bottom + 6,
            filePath: hovered.filePath,
            side: hovered.side,
            anchor,
          })
        })
      }
      container.addEventListener('mouseup', handleMouseUp)
      return () => container.removeEventListener('mouseup', handleMouseUp)
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
                onBodyChange={(body) => updateDraft(draftKey(p), { body })}
                onSuggestModeChange={(suggestMode) => updateDraft(draftKey(p), { suggestMode })}
                onSuggestionTextChange={(suggestionText) => updateDraft(draftKey(p), { suggestionText })}
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

    const handleToggleCollapse = useStableCallback((itemId: string) => {
      const viewer = viewerRef.current
      if (!viewer) return
      const item = viewer.getItem(itemId)
      if (!item || item.type !== 'diff') return
      item.collapsed = item.collapsed !== true
      item.version = bumpVersion(item)
      viewer.updateItem(item)
    })

    const renderHeaderPrefix = useStableCallback(
      (item: CodeViewItem<Metadata>) => {
        if (item.type !== 'diff') return null
        const viewed = viewedFiles.has(item.id)
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
            {onEditFile && (
              <button
                type="button"
                className="codeview-edit-btn"
                title="Edit file in browser"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onEditFile(item.id)
                }}
              >
                Edit
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
            container-name: diffx-sticky-header;
          }
          @container diffx-sticky-header scroll-state(stuck: top) {
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
      [diffStyle, defaultTabSize, handleGutterClick, handleLineEnter],
    )

    return (
      <>
        <CodeView<Metadata>
          key={structuralRevision}
          ref={(v) => {
            viewerRef.current = v
          }}
          containerRef={scrollRef}
          initialItems={initialItems}
          options={options}
          onScroll={handleScroll}
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
      </>
    )
  }),
)

function buildItems(
  files: FileDiffMetadata[],
  fileAnnotationsMap: Map<string, DiffLineAnnotation<ReviewComment>[]>,
  pending: Map<string, DraftMetadata>,
  viewedFiles: Set<string>,
  fileStatsMap: Record<string, { additions: number; deletions: number }>,
): CodeViewItem<Metadata>[] {
  return files.map((fileDiff) => {
    const stats = fileStatsMap[fileDiff.name]
    const changeCount = (stats?.additions ?? 0) + (stats?.deletions ?? 0)
    // Initial collapse: viewed files (carryover from a prior session) and
    // very large diffs. Manual chevron toggle still overrides.
    const collapsed =
      viewedFiles.has(fileDiff.name) || changeCount > AUTO_COLLAPSE_CHANGE_THRESHOLD
    return {
      id: fileDiff.name,
      type: 'diff' as const,
      fileDiff,
      collapsed,
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
