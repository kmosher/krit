import { useMemo, useRef, useState, useCallback, useLayoutEffect, memo } from 'react'
import type { UIEvent } from 'react'
import {
  MessageSquare,
  CheckCircle2,
  Reply,
  Circle,
  PenLine,
} from 'lucide-react'
import type { ReviewComment } from '../../types'
import { timeAgo, truncate, fileName } from '../utils'

interface CommentTrackerProps {
  comments: ReviewComment[]
  onJump?: (comment: ReviewComment) => void
  onDelete?: (id: string) => void
}

type CommentStatus = 'draft' | 'open' | 'replied' | 'resolved'

function getCommentStatus(comment: ReviewComment): CommentStatus {
  if (comment.status === 'draft') return 'draft'
  if (comment.status === 'resolved') return 'resolved'
  if (comment.replies?.length > 0) return 'replied'
  return 'open'
}

function StatusBadge({ status }: { status: CommentStatus }) {
  switch (status) {
    case 'draft':
      return (
        <span className="ct-status ct-status-draft" title="Draft — not yet posted">
          <PenLine size={12} />
        </span>
      )
    case 'open':
      return (
        <span className="ct-status ct-status-open" title="Open">
          <Circle size={12} />
        </span>
      )
    case 'replied':
      return (
        <span className="ct-status ct-status-replied" title="Replied">
          <Reply size={12} />
        </span>
      )
    case 'resolved':
      return (
        <span className="ct-status ct-status-resolved" title="Resolved">
          <CheckCircle2 size={12} />
        </span>
      )
  }
}

// Fixed row height for windowing. `.ct-item` has no explicit CSS height, but
// both of its text lines are `white-space: nowrap` (never wrap), so the
// rendered height is stable: ~22px link padding + ~16px header row + 4px
// margin + ~17px body line, rounded up with a little slack.
const ROW_HEIGHT = 64
const OVERSCAN = 10

const CommentRow = memo(function CommentRow({
  comment,
  status,
  top,
  onJump,
  onDelete,
}: {
  comment: ReviewComment
  status: CommentStatus
  top: number
  onJump?: (comment: ReviewComment) => void
  onDelete?: (id: string) => void
}) {
  return (
    <li
      className={`ct-item ${status === 'resolved' ? 'ct-item-resolved' : ''}`}
      style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_HEIGHT }}
    >
      <a
        href={`#comment-${comment.id}`}
        className="ct-item-link"
        onClick={(e) => {
          if (onJump) {
            e.preventDefault()
            onJump(comment)
          }
        }}
      >
        <div className="ct-item-header">
          <StatusBadge status={status} />
          <span className="ct-item-file" title={comment.filePath}>
            {fileName(comment.filePath)}:{comment.lineNumber}
            {comment.endLine && comment.endLine > comment.lineNumber ? `–${comment.endLine}` : ''}
          </span>
          <span className="ct-item-time">{timeAgo(comment.createdAt)}</span>
        </div>
        <div className="ct-item-body">{truncate(comment.body, 80)}</div>
      </a>
      {onDelete && (
        <button
          className="ct-item-delete"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onDelete(comment.id)
          }}
          title="Delete comment"
          aria-label="Delete comment"
        >
          &times;
        </button>
      )}
    </li>
  )
})

function CommentTrackerImpl({ comments, onJump, onDelete }: CommentTrackerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [headerHeight, setHeaderHeight] = useState(0)

  // Sort + all four status counts in one memoized pass, recomputed only
  // when `comments` actually changes identity (not on every render).
  const { sorted, draftCount, openCount, repliedCount, resolvedCount } = useMemo(() => {
    const sorted = [...comments].sort((a, b) => b.createdAt - a.createdAt)
    let draftCount = 0
    let openCount = 0
    let repliedCount = 0
    let resolvedCount = 0
    for (const comment of sorted) {
      switch (getCommentStatus(comment)) {
        case 'draft':
          draftCount++
          break
        case 'open':
          openCount++
          break
        case 'replied':
          repliedCount++
          break
        case 'resolved':
          resolvedCount++
          break
      }
    }
    return { sorted, draftCount, openCount, repliedCount, resolvedCount }
  }, [comments])

  const handleScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  // `.ct` (measured here) is the scroll container for BOTH the header and
  // the row list — it scrolls as one region (unchanged from before
  // virtualization). Track the header's rendered height separately so the
  // row-window math below can subtract it out: scrollTop is relative to the
  // top of the header, but row 0's true position is right after it.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [sorted.length])

  useLayoutEffect(() => {
    const el = headerRef.current
    if (!el) return
    setHeaderHeight(el.offsetHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setHeaderHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [draftCount, openCount, repliedCount, resolvedCount])

  const total = sorted.length
  const listScrollTop = Math.max(0, scrollTop - headerHeight)
  const startIndex = Math.max(0, Math.floor(listScrollTop / ROW_HEIGHT) - OVERSCAN)
  const endIndex = Math.min(total, Math.ceil((listScrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
  const visible = sorted.slice(startIndex, endIndex)

  if (total === 0) return null

  return (
    <div className="ct" ref={scrollRef} onScroll={handleScroll}>
      <div className="ct-header" ref={headerRef}>
        <MessageSquare size={14} />
        <span className="ct-title">Comments</span>
        <span className="ct-counts">
          {draftCount > 0 && <span className="ct-count ct-count-draft">{draftCount} draft</span>}
          {openCount > 0 && <span className="ct-count ct-count-open">{openCount} open</span>}
          {repliedCount > 0 && <span className="ct-count ct-count-replied">{repliedCount} replied</span>}
          {resolvedCount > 0 && <span className="ct-count ct-count-resolved">{resolvedCount} resolved</span>}
        </span>
      </div>
      <ul className="ct-list" style={{ position: 'relative', height: total * ROW_HEIGHT }}>
        {visible.map((comment, i) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            status={getCommentStatus(comment)}
            top={(startIndex + i) * ROW_HEIGHT}
            onJump={onJump}
            onDelete={onDelete}
          />
        ))}
      </ul>
    </div>
  )
}

export const CommentTracker = memo(CommentTrackerImpl)
