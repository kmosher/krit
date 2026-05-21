import { useState, useEffect, useRef, useMemo, memo } from 'react'
import { FileDiff, MultiFileDiff } from '@pierre/diffs/react'
import type { DiffLineAnnotation, FileDiffMetadata, AnnotationSide, FileContents } from '@pierre/diffs'
import type { ReviewComment } from '../../types'
import { CommentForm } from './CommentForm'
import { CommentBubble } from './CommentBubble'
import { useFileContents } from '../hooks/useFileContents'

interface PendingComment {
  side: AnnotationSide
  startLine: number
  endLine: number
}

interface FileDiffCardProps {
  id?: string
  fileDiff: FileDiffMetadata
  filePath: string
  annotations: DiffLineAnnotation<ReviewComment>[]
  diffStyle: 'split' | 'unified'
  tabSize: number
  viewed: boolean
  baseRef: string
  headRef: string
  onViewedChange: (filePath: string, viewed: boolean) => void
  onAddComment: (filePath: string, side: AnnotationSide, lineNumber: number, endLine: number, lineContent: string, body: string) => void
  onDeleteComment: (id: string) => void
  onReplyComment: (id: string, body: string) => void
}

export const FileDiffCard = memo(function FileDiffCard({
  id,
  fileDiff,
  filePath,
  annotations,
  diffStyle,
  tabSize,
  viewed,
  baseRef,
  headRef,
  onViewedChange,
  onAddComment,
  onDeleteComment,
  onReplyComment,
}: FileDiffCardProps) {
  const [pending, setPending] = useState<PendingComment | null>(null)

  // Lazy fetch: trigger when this card scrolls into view (or 200px before it does).
  // Once activated, we stay activated for the lifetime of the card — re-fetches on
  // scroll would defeat the @tanstack cache.
  const cardRef = useRef<HTMLDivElement>(null)
  const [contentsEnabled, setContentsEnabled] = useState(false)
  const [forceOversize, setForceOversize] = useState(false)
  useEffect(() => {
    if (contentsEnabled) return
    const el = cardRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setContentsEnabled(true)
          obs.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [contentsEnabled])

  const { baseContents, headContents, oversize, size } = useFileContents(filePath, {
    enabled: contentsEnabled && !viewed,
    force: forceOversize,
    baseRef,
    headRef,
  })
  const oldFile: FileContents | undefined = useMemo(
    () => (baseContents != null ? { name: filePath, contents: baseContents } : undefined),
    [filePath, baseContents],
  )
  const newFile: FileContents | undefined = useMemo(
    () => (headContents != null ? { name: filePath, contents: headContents } : undefined),
    [filePath, headContents],
  )

  // Resolve one line's text from the diff side. Returns '' for lines outside any hunk.
  const getLineContent = (side: AnnotationSide, lineNumber: number): string => {
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

  // Concatenate one line per row in [startLine, endLine] (inclusive), newline-joined.
  // Rows outside any hunk (gutter selection can sweep past hunk boundaries) yield ''
  // from getLineContent; we drop those so trailing empty lines don't corrupt the
  // agent's view of what the user actually highlighted.
  const getRangeContent = (side: AnnotationSide, startLine: number, endLine: number): string => {
    const out: string[] = []
    for (let n = startLine; n <= endLine; n++) {
      const line = getLineContent(side, n)
      if (line !== '') out.push(line)
    }
    return out.join('\n')
  }

  // Translate the library's SelectedLineRange into our pending-comment shape, or null
  // if the selection is unusable (no side, or cross-side drag on a split diff — both
  // sides have independent line-number coordinate spaces, so we can't form a single span).
  const rangeFromGutterClick = (
    range: { start: number; end: number; side?: AnnotationSide; endSide?: AnnotationSide },
  ): PendingComment | null => {
    const side = range.side ?? range.endSide
    if (!side) return null
    if (range.endSide && range.side && range.endSide !== range.side) return null
    return {
      side,
      startLine: Math.min(range.start, range.end),
      endLine: Math.max(range.start, range.end),
    }
  }

  // Anchor the pending form at the end of the selected range so it appears just below
  // the highlighted lines (matches GitHub's behavior for multi-line review comments).
  const allAnnotations: DiffLineAnnotation<ReviewComment | { _pending: true }>[] = [
    ...annotations,
    ...(pending
      ? [
          {
            side: pending.side,
            lineNumber: pending.endLine,
            metadata: { _pending: true as const },
          },
        ]
      : []),
  ]

  return (
    <div ref={cardRef} className={`file-diff-card ${viewed ? 'file-diff-viewed' : ''}`} id={id}>
      {viewed ? (
        <div className="file-diff-viewed-header">
          <span className="file-diff-viewed-name">{filePath}</span>
          <label className="viewed-label viewed-checked" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={viewed}
              onChange={(e) => onViewedChange(filePath, e.target.checked)}
            />
            Viewed
          </label>
        </div>
      ) : (
        <>
          {oversize && !forceOversize && (
            <div className="file-diff-oversize-banner">
              <span>
                File is {(size / (1024 * 1024)).toFixed(1)} MB — context expansion is disabled by default.
              </span>
              <button
                className="btn btn-secondary"
                onClick={() => setForceOversize(true)}
                title="Load the file anyway. May be slow or memory-hungry on very large files."
              >
                Load anyway
              </button>
            </div>
          )}
          {(() => {
            // Props shared between FileDiff (patch-derived, no expansion) and
            // MultiFileDiff (content-derived, supports hunk expansion). We render whichever
            // one has the data it needs: MultiFileDiff when both file sides are loaded,
            // FileDiff otherwise (loading, added/deleted file, or oversize-not-forced).
            const sharedOptions = {
              diffStyle,
              enableGutterUtility: true,
              // Required so the drag *shows* a line highlight as the user pulls down
              // the gutter. Without this the gesture silently builds a range but
              // looks broken — the user sees no feedback and assumes nothing is happening.
              enableLineSelection: true,
              // Built-in gutter selection: click the `+` for a single line, or press-and-drag
              // from the `+` down/up across the gutter to span multiple lines.
              onGutterUtilityClick: (range: { start: number; end: number; side?: AnnotationSide; endSide?: AnnotationSide }) => {
                // Don't clobber an in-progress comment form — the user may have typed text
                // they don't want to lose. They can Cancel the existing form first.
                if (pending) return
                const next = rangeFromGutterClick(range)
                if (next) setPending(next)
              },
              theme: { dark: 'github-dark' as const, light: 'github-light' as const },
              themeType: 'system' as const,
              unsafeCSS: `:host { --diffs-tab-size: ${tabSize}; }`,
            }
            const renderHeaderMetadata = () => (
              <label className="viewed-label" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={viewed}
                  onChange={(e) => onViewedChange(filePath, e.target.checked)}
                />
                Viewed
              </label>
            )
            const renderAnnotation = (
              annotation: DiffLineAnnotation<ReviewComment | { _pending: true }>,
            ) => {
              if ('_pending' in annotation.metadata) {
                const rangeLabel =
                  pending && pending.endLine > pending.startLine
                    ? `Commenting on lines ${pending.startLine}–${pending.endLine}`
                    : null
                return (
                  <div>
                    {rangeLabel && <div className="comment-range-label">{rangeLabel}</div>}
                    <CommentForm
                      onSubmit={(body) => {
                        const lineContent = getRangeContent(pending!.side, pending!.startLine, pending!.endLine)
                        onAddComment(filePath, pending!.side, pending!.startLine, pending!.endLine, lineContent, body)
                        setPending(null)
                      }}
                      onCancel={() => setPending(null)}
                    />
                  </div>
                )
              }
              return (
                <CommentBubble
                  comment={annotation.metadata as ReviewComment}
                  onDelete={onDeleteComment}
                  onReply={onReplyComment}
                />
              )
            }

            if (oldFile && newFile) {
              return (
                <MultiFileDiff<ReviewComment | { _pending: true }>
                  oldFile={oldFile}
                  newFile={newFile}
                  options={sharedOptions}
                  lineAnnotations={allAnnotations}
                  renderHeaderMetadata={renderHeaderMetadata}
                  renderAnnotation={renderAnnotation}
                />
              )
            }
            return (
              <FileDiff<ReviewComment | { _pending: true }>
                fileDiff={fileDiff}
                options={sharedOptions}
                lineAnnotations={allAnnotations}
                renderHeaderMetadata={renderHeaderMetadata}
                renderAnnotation={renderAnnotation}
              />
            )
          })()}
        </>
      )}
    </div>
  )
})
