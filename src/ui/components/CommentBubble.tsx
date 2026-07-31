import { useState, useEffect, useRef } from 'react'
import { UserCircle, CheckCircle2, Bot, Reply, History, PenLine } from 'lucide-react'
import type { ReviewComment } from '../../types'
import { timeAgo } from '../utils'
import { CommentForm } from './CommentForm'
import { QueuedCommentEditor } from './QueuedCommentEditor'

interface CommentBubbleProps {
  comment: ReviewComment
  onDelete: (id: string) => void
  onReply: (id: string, body: string) => void
  // Rewrite a queued comment's text. Only queued comments offer it: a posted
  // comment has already reached the agent, and the update route broadcasts
  // nothing for a body change, so editing one would leave the reviewer and the
  // agent reading different text with nothing to say so. Optional, for the
  // surfaces that render comments read-only.
  onEdit?: (id: string, body: string) => Promise<void> | void
}

export function CommentBubble({ comment, onDelete, onReply, onEdit }: CommentBubbleProps) {
  const [, setTick] = useState(0)
  const [replying, setReplying] = useState(false)
  const [editing, setEditing] = useState(false)
  // Belt and braces for the same hazard the `key` at the call site addresses:
  // this component is reused across comments wherever a caller forgets it, and
  // an open editor carried onto another comment saves one comment's text under
  // another comment's id. Reset rather than trust every future call site.
  const lastIdRef = useRef(comment.id)
  if (lastIdRef.current !== comment.id) {
    lastIdRef.current = comment.id
    if (editing) setEditing(false)
    if (replying) setReplying(false)
  }
  const isResolved = comment.status === 'resolved'
  const isQueued = comment.status === 'queued'

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000)
    return () => clearInterval(timer)
  }, [])

  const endLine = comment.endLine ?? comment.lineNumber
  const isRange = endLine > comment.lineNumber

  return (
    <div className={`comment-bubble ${isResolved ? 'comment-resolved' : ''} ${isQueued ? 'comment-queued' : ''}`} id={`comment-${comment.id}`}>
      <div className="comment-bubble-header">
        <UserCircle size={18} className="comment-bubble-avatar" />
        {isRange && (
          <span className="comment-bubble-range" title={`Lines ${comment.lineNumber}–${endLine}`}>
            L{comment.lineNumber}–L{endLine}
          </span>
        )}
        <span className="comment-bubble-time">{timeAgo(comment.createdAt)}</span>
        {isQueued &&
          (onEdit ? (
            // The badge is the edit affordance: a queued comment is the one the
            // reviewer can still take back, and the pen already says so.
            <button
              type="button"
              className="comment-bubble-queued comment-bubble-queued-btn"
              onClick={() => setEditing((e) => !e)}
              aria-expanded={editing}
              title="Queued — click to edit. Saved but not posted, so it stays invisible to the listening Claude session until you post it (or click Done reviewing)."
            >
              <PenLine size={14} />
              Queued
            </button>
          ) : (
            <span
              className="comment-bubble-queued"
              title="Saved but not posted — invisible to the listening Claude session until you post it (or click Done reviewing)."
            >
              <PenLine size={14} />
              Queued
            </span>
          ))}
        {isResolved && (
          <span className="comment-bubble-resolved">
            <CheckCircle2 size={14} />
            Resolved
          </span>
        )}
        {comment.outdated && !isResolved && (
          <span
            className="comment-bubble-outdated"
            title="The lines this comment was anchored to changed and couldn't be confidently re-matched — position may be off."
          >
            <History size={14} />
            Outdated
          </span>
        )}
        <button
          className="comment-bubble-delete"
          onClick={() => onDelete(comment.id)}
          title="Delete comment"
          aria-label="Delete comment"
        >
          &times;
        </button>
      </div>
      {editing && isQueued && onEdit ? (
        <QueuedCommentEditor
          initialBody={comment.body}
          // Closed only once the rewrite is stored: a refused save (the comment
          // was posted while it was in flight) has to leave the text on screen.
          onSave={async (body) => {
            await onEdit(comment.id, body)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        comment.body && <div className="comment-bubble-body">{comment.body}</div>
      )}
      {comment.suggestion && (
        <div className="comment-suggestion" title="Suggested rewrite">
          <div className="comment-suggestion-label">Suggested rewrite</div>
          <pre className="comment-suggestion-old">
            {comment.lineContent.split('\n').map((l, i) => (
              <div key={`o-${i}`} className="comment-suggestion-line del">- {l || ' '}</div>
            ))}
          </pre>
          <pre className="comment-suggestion-new">
            {comment.suggestion.newLines.map((l, i) => (
              <div key={`n-${i}`} className="comment-suggestion-line add">+ {l || ' '}</div>
            ))}
          </pre>
        </div>
      )}
      {comment.replies?.length > 0 && (
        <div className="comment-replies">
          {comment.replies.map((reply) => {
            // Older replies (pre-author field) were always from the bot.
            const isUser = reply.author === 'user'
            return (
              <div key={reply.id} className={`comment-reply ${isUser ? 'comment-reply-user' : 'comment-reply-agent'}`}>
                <div className="comment-reply-header">
                  {isUser ? (
                    <UserCircle size={16} className="comment-reply-avatar" />
                  ) : (
                    <Bot size={16} className="comment-reply-avatar" />
                  )}
                  <span className="comment-reply-author">{isUser ? 'You' : 'Agent'}</span>
                  <span className="comment-bubble-time">{timeAgo(reply.createdAt)}</span>
                </div>
                <div className="comment-reply-body">{reply.body}</div>
              </div>
            )
          })}
        </div>
      )}
      {replying ? (
        <div className="comment-reply-form">
          <CommentForm
            filePath={comment.filePath}
            onSubmit={(body) => {
              onReply(comment.id, body)
              setReplying(false)
            }}
            onCancel={() => setReplying(false)}
          />
        </div>
      ) : (
        <button className="comment-bubble-reply-btn" onClick={() => setReplying(true)}>
          <Reply size={12} />
          Reply
        </button>
      )}
    </div>
  )
}
