import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReviewComment } from '../../types'
import type { SelectionAnchor } from '../utils/selectionMapping'
import type { PreviewFormat } from '../utils/previewFormat'
import {
  buildLineIndex,
  lineColToOffset,
  offsetToLineCol,
  previewRangeToAnchor,
  sourceRangeToDomRange,
} from '../utils/previewAnchor'
import { buildHtmlTextMap, locateSelection } from '../utils/htmlTextMap'
import { asBridgeMessage, buildSandboxDocument } from '../utils/htmlSandbox'
import { setFileHighlights } from '../utils/previewHighlights'
import { MarkdownPreview } from './MarkdownPreview'
import { SelectionPill } from './SelectionPill'
import { CommentForm } from './CommentForm'
import { CommentBubble } from './CommentBubble'

// The rendered document itself: the file read as what it is, with its comments
// alongside. Mounted as a file-level annotation inside CodeView, in place of
// the file's diff rows — see CodeViewWrapper's `_preview` metadata and
// docs/design/rendered-preview.md.

export interface PreviewPaneProps {
  filePath: string
  source: string
  format: PreviewFormat
  /** Inclusive new-side line ranges this diff added or modified. */
  changedRanges: Array<[number, number]>
  comments: ReviewComment[]
  onAddComment: (
    filePath: string,
    side: 'deletions' | 'additions',
    lineNumber: number,
    endLine: number,
    lineContent: string,
    body: string,
    suggestion?: { newLines: string[] },
    asQueued?: boolean,
    charAnchor?: { startColumn: number; endColumn: number; selectedText: string },
  ) => void
  onDeleteComment: (id: string) => void
  onReplyComment: (id: string, body: string) => void
  onEditComment: (id: string, body: string) => void
}

interface PendingSelection {
  anchor: SelectionAnchor
  /** Source offsets, kept so the suggest editor can be seeded with real source. */
  startOffset: number
  endOffset: number
  /** What the reader saw and highlighted, which after an outward snap is a
   *  subset of the source range. Shown in the UI; not what gets persisted. */
  renderedText: string
  x: number
  y: number
}

export function PreviewPane({
  filePath,
  source,
  format,
  changedRanges,
  comments,
  onAddComment,
  onDeleteComment,
  onReplyComment,
  onEditComment,
}: PreviewPaneProps) {
  const lineStarts = useMemo(() => buildLineIndex(source), [source])
  const bodyRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState<PendingSelection | null>(null)
  const [drafting, setDrafting] = useState<PendingSelection | null>(null)
  const [frameHeight, setFrameHeight] = useState(600)

  const sliceSource = useCallback(
    (startOffset: number, endOffset: number) => source.slice(startOffset, endOffset),
    [source],
  )

  // The anchored lines' full text, matching what the diff path stores in
  // `lineContent` so a preview comment is indistinguishable downstream.
  const lineContentFor = useCallback(
    (startLine: number, endLine: number) => {
      const lines: string[] = []
      for (let n = startLine; n <= endLine; n++) {
        const from = lineStarts[n - 1]
        if (from == null) break
        const to = n < lineStarts.length ? lineStarts[n] - 1 : source.length
        lines.push(source.slice(from, to))
      }
      return lines.join('\n')
    },
    [lineStarts, source],
  )

  const capture = useCallback(
    (anchor: SelectionAnchor, renderedText: string, x: number, y: number) => {
      const startOffset = lineColToOffset(lineStarts, anchor.startLine, anchor.startColumn)
      const endOffset = lineColToOffset(lineStarts, anchor.endLine, anchor.endColumn)
      setPending({ anchor, startOffset, endOffset, renderedText, x, y })
    },
    [lineStarts],
  )

  // --- Markdown: the selection lives in this document, so read it directly.
  useEffect(() => {
    if (format !== 'markdown') return
    const onMouseUp = (e: MouseEvent) => {
      // The pill's own buttons are inside this document; a mouseup on them is
      // not a new selection and must not clear the one being acted on.
      if (pillRef.current?.contains(e.target as Node)) return
      // Let the browser finish updating the selection first.
      setTimeout(() => {
        const root = bodyRef.current
        const sel = window.getSelection()
        if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
          setPending(null)
          return
        }
        const range = sel.getRangeAt(0)
        // Several panes can be open at once, each listening on the document.
        // Only the one the selection is actually inside may claim it.
        if (!root.contains(range.commonAncestorContainer)) {
          setPending(null)
          return
        }
        const anchor = previewRangeToAnchor(range, root, source, lineStarts)
        if (!anchor) {
          setPending(null)
          return
        }
        const rect = range.getBoundingClientRect()
        capture(anchor, range.toString(), rect.right, rect.bottom + 6)
      }, 0)
    }
    document.addEventListener('mouseup', onMouseUp)
    return () => document.removeEventListener('mouseup', onMouseUp)
  }, [format, source, lineStarts, capture])

  // --- HTML: the artifact runs in an opaque origin, so its selection can only
  // arrive by postMessage from the injected bridge.
  const textMap = useMemo(
    () => (format === 'html' ? buildHtmlTextMap(source) : null),
    [format, source],
  )
  useEffect(() => {
    if (format !== 'html' || !textMap) return
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return
      const msg = asBridgeMessage(e.data)
      if (!msg) return
      if (msg.type === 'height') {
        setFrameHeight(Math.max(200, Math.min(msg.height, 20000)))
        return
      }
      if (!msg.text || !msg.text.trim()) {
        setPending(null)
        return
      }
      const located = locateSelection(textMap, msg.text, msg.textOffset ?? -1)
      if (!located) {
        setPending(null)
        return
      }
      const start = offsetToLineCol(lineStarts, located.startOffset)
      const end = offsetToLineCol(lineStarts, located.endOffset)
      const frameRect = frameRef.current?.getBoundingClientRect()
      const r = msg.rect
      capture(
        {
          startLine: start.line,
          startColumn: start.column,
          endLine: end.line,
          endColumn: end.column,
          selectedText: msg.text,
        },
        msg.text,
        (frameRect?.left ?? 0) + (r?.right ?? 0),
        (frameRect?.top ?? 0) + (r?.bottom ?? 0) + 6,
      )
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [format, textMap, lineStarts, capture])

  // Paint existing comments' anchors with the CSS Custom Highlight API rather
  // than wrapping ranges in <mark>: React owns this DOM, and mutating it
  // underneath would be undone on the next render (and would shift the very
  // offsets the highlight was computed from). Registered per file, because
  // several panes can be open at once and the API is keyed globally.
  useEffect(() => {
    if (format !== 'markdown') return
    const root = bodyRef.current
    if (!root) return
    const ranges: Range[] = []
    for (const c of comments) {
      if (c.startColumn == null || c.endColumn == null) continue
      const from = lineColToOffset(lineStarts, c.lineNumber, c.startColumn)
      const to = lineColToOffset(lineStarts, c.endLine ?? c.lineNumber, c.endColumn)
      const range = sourceRangeToDomRange(root, source, from, to)
      if (range) ranges.push(range)
    }
    setFileHighlights(filePath, ranges)
    return () => setFileHighlights(filePath, [])
  }, [format, comments, lineStarts, source, filePath])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pending && !drafting) setPending(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending, drafting])

  const submitComment = (
    sel: PendingSelection,
    body: string,
    suggestion: { newLines: string[] } | undefined,
    asQueued: boolean,
  ) => {
    const { anchor } = sel
    onAddComment(
      filePath,
      'additions',
      anchor.startLine,
      anchor.endLine,
      lineContentFor(anchor.startLine, anchor.endLine),
      body,
      suggestion,
      asQueued,
      {
        startColumn: anchor.startColumn,
        endColumn: anchor.endColumn,
        // The source slice, not the rendered text: schema v3 defines
        // selectedText as the text between the two anchor points, and a
        // suggestion has to be a literal patch against the file.
        selectedText: sliceSource(sel.startOffset, sel.endOffset),
      },
    )
    setDrafting(null)
    setPending(null)
  }

  return (
    <div className="preview-pane">
      <div className="preview-pane-content" ref={bodyRef}>
        {format === 'markdown' ? (
          <MarkdownPreview source={source} changedRanges={changedRanges} />
        ) : (
          <iframe
            ref={frameRef}
            className="preview-pane-frame"
            title={`Preview of ${filePath}`}
            // No allow-same-origin: with it, the sandbox would grant the
            // artifact this page's origin back, and this page can write
            // files. See htmlSandbox.ts.
            sandbox="allow-scripts"
            srcDoc={buildSandboxDocument(source)}
            style={{ height: frameHeight }}
          />
        )}
      </div>

      <aside className="preview-pane-rail">
        {drafting && (
          <div className="preview-rail-card preview-rail-draft">
            <div className="preview-rail-quote" title={drafting.renderedText}>
              “{truncate(drafting.renderedText, 140)}”
            </div>
            <div className="preview-rail-lines">
              {drafting.anchor.startLine === drafting.anchor.endLine
                ? `Line ${drafting.anchor.startLine}`
                : `Lines ${drafting.anchor.startLine}–${drafting.anchor.endLine}`}
            </div>
            <CommentForm
              filePath={filePath}
              // The source behind the selection, not the rendered text —
              // otherwise the reader would be editing `bold` where the file
              // says `**bold**` and the suggestion could not apply.
              originalLines={sliceSource(drafting.startOffset, drafting.endOffset)}
              onSubmit={(body, suggestion) => submitComment(drafting, body, suggestion, false)}
              onQueue={(body, suggestion) => submitComment(drafting, body, suggestion, true)}
              onCancel={() => setDrafting(null)}
            />
          </div>
        )}
        {comments.length === 0 && !drafting && (
          <p className="preview-rail-empty">
            Select any text to comment on it. Changed blocks are marked in the margin.
          </p>
        )}
        {comments.map((c) => (
          <div key={c.id} className="preview-rail-card">
            {c.selectedText && (
              <div className="preview-rail-quote" title={c.selectedText}>
                “{truncate(c.selectedText, 140)}”
              </div>
            )}
            <CommentBubble
              comment={c}
              onDelete={onDeleteComment}
              onReply={onReplyComment}
              onEdit={onEditComment}
            />
          </div>
        ))}
      </aside>

      {/* Portaled to <body>: the pill is `position: fixed`, and Pierre's
          virtualizer puts a `transform` on the row containers above this pane.
          A transformed ancestor becomes the containing block for fixed
          positioning, so left in place the pill lands at an offset from the
          selection rather than on it. */}
      {pending &&
        !drafting &&
        createPortal(
          <div ref={pillRef}>
            <SelectionPill
              x={pending.x}
              y={pending.y}
              onComment={() => {
                setDrafting(pending)
                setPending(null)
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  )
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
