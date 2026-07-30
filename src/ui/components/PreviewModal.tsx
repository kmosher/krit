import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { MarkdownPreview } from './MarkdownPreview'
import { SelectionPill } from './SelectionPill'
import { CommentForm } from './CommentForm'
import { CommentBubble } from './CommentBubble'

// Reads a file as the document it is rather than as a diff, and takes comments
// on it. A selection here produces the same schema-v3 anchor a selection over
// the diff produces, so everything downstream — drafts, suggestions,
// re-anchoring, the agent's view — is unchanged. See
// docs/design/rendered-preview.md.

interface Props {
  filePath: string
  source: string
  format: PreviewFormat
  /** Inclusive new-side line ranges this diff added or modified. */
  changedRanges: Array<[number, number]>
  comments: ReviewComment[]
  onClose: () => void
  onAddComment: (
    filePath: string,
    side: 'deletions' | 'additions',
    lineNumber: number,
    endLine: number,
    lineContent: string,
    body: string,
    suggestion?: { newLines: string[] },
    asDraft?: boolean,
    charAnchor?: { startColumn: number; endColumn: number; selectedText: string },
  ) => void
  onDeleteComment: (id: string) => void
  onReplyComment: (id: string, body: string) => void
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

const HIGHLIGHT_NAME = 'krit-comment'

export function PreviewModal({
  filePath,
  source,
  format,
  changedRanges,
  comments,
  onClose,
  onAddComment,
  onDeleteComment,
  onReplyComment,
}: Props) {
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
  // offsets the highlight was computed from). Silently absent where the API
  // is — the rail still lists every comment.
  useEffect(() => {
    if (format !== 'markdown') return
    const root = bodyRef.current
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    if (!root || !highlights || typeof Highlight === 'undefined') return
    const ranges: Range[] = []
    for (const c of comments) {
      if (c.startColumn == null || c.endColumn == null) continue
      const from = lineColToOffset(lineStarts, c.lineNumber, c.startColumn)
      const to = lineColToOffset(lineStarts, c.endLine ?? c.lineNumber, c.endColumn)
      const range = sourceRangeToDomRange(root, source, from, to)
      if (range) ranges.push(range)
    }
    if (ranges.length) highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges))
    else highlights.delete(HIGHLIGHT_NAME)
    return () => {
      highlights.delete(HIGHLIGHT_NAME)
    }
  }, [format, comments, lineStarts, source])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (drafting) return // CommentForm owns Escape while a draft is open.
      if (pending) {
        setPending(null)
        return
      }
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drafting, pending, onClose])

  const submitComment = (
    sel: PendingSelection,
    body: string,
    suggestion: { newLines: string[] } | undefined,
    asDraft: boolean,
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
      asDraft,
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

  const anchored = comments.filter((c) => c.startColumn != null)
  const wholeFile = comments.filter((c) => c.startColumn == null)

  return (
    <div className="preview-modal-backdrop" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-modal-header">
          <span className="preview-modal-path">{filePath}</span>
          <span className="preview-modal-format">{format === 'markdown' ? 'Markdown' : 'HTML'}</span>
          {comments.length > 0 && (
            <span className="preview-modal-count">
              {comments.length} comment{comments.length === 1 ? '' : 's'}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn btn-secondary" onClick={onClose}>
            Back to diff
          </button>
        </div>

        <div className="preview-modal-split">
          <div className="preview-modal-content" ref={bodyRef}>
            {format === 'markdown' ? (
              <MarkdownPreview source={source} changedRanges={changedRanges} />
            ) : (
              <iframe
                ref={frameRef}
                className="preview-modal-frame"
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

          <aside className="preview-modal-rail">
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
                  onSaveDraft={(body, suggestion) => submitComment(drafting, body, suggestion, true)}
                  onCancel={() => setDrafting(null)}
                />
              </div>
            )}
            {anchored.length === 0 && wholeFile.length === 0 && !drafting && (
              <p className="preview-rail-empty">
                Select any text to comment on it. Changed blocks are marked in the margin.
              </p>
            )}
            {[...anchored, ...wholeFile].map((c) => (
              <div key={c.id} className="preview-rail-card">
                {c.selectedText && (
                  <div className="preview-rail-quote" title={c.selectedText}>
                    “{truncate(c.selectedText, 140)}”
                  </div>
                )}
                <CommentBubble comment={c} onDelete={onDeleteComment} onReply={onReplyComment} />
              </div>
            ))}
          </aside>
        </div>

        {pending && !drafting && (
          <div ref={pillRef}>
            <SelectionPill
              x={pending.x}
              y={pending.y}
              onComment={() => {
                setDrafting(pending)
                setPending(null)
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
