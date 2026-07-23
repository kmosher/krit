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

export function CommentTracker({ comments, onJump, onDelete }: CommentTrackerProps) {
  if (comments.length === 0) return null

  const sorted = [...comments].sort((a, b) => b.createdAt - a.createdAt)

  const draftCount = sorted.filter((c) => getCommentStatus(c) === 'draft').length
  const openCount = sorted.filter((c) => getCommentStatus(c) === 'open').length
  const repliedCount = sorted.filter((c) => getCommentStatus(c) === 'replied').length
  const resolvedCount = sorted.filter((c) => getCommentStatus(c) === 'resolved').length

  return (
    <div className="ct">
      <div className="ct-header">
        <MessageSquare size={14} />
        <span className="ct-title">Comments</span>
        <span className="ct-counts">
          {draftCount > 0 && <span className="ct-count ct-count-draft">{draftCount} draft</span>}
          {openCount > 0 && <span className="ct-count ct-count-open">{openCount} open</span>}
          {repliedCount > 0 && <span className="ct-count ct-count-replied">{repliedCount} replied</span>}
          {resolvedCount > 0 && <span className="ct-count ct-count-resolved">{resolvedCount} resolved</span>}
        </span>
      </div>
      <ul className="ct-list">
        {sorted.map((comment) => {
          const status = getCommentStatus(comment)
          return (
            <li
              key={comment.id}
              className={`ct-item ${status === 'resolved' ? 'ct-item-resolved' : ''}`}
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
        })}
      </ul>
    </div>
  )
}
