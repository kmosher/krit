import { useState, useEffect } from 'react'
import { UserCircle, CheckCircle2, Bot, Reply } from 'lucide-react'
import type { ReviewComment } from '../../types'
import { timeAgo } from '../utils'
import { CommentForm } from './CommentForm'

interface CommentBubbleProps {
  comment: ReviewComment
  onDelete: (id: string) => void
  onReply: (id: string, body: string) => void
}

export function CommentBubble({ comment, onDelete, onReply }: CommentBubbleProps) {
  const [, setTick] = useState(0)
  const [replying, setReplying] = useState(false)
  const isResolved = comment.status === 'resolved'

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000)
    return () => clearInterval(timer)
  }, [])

  const endLine = comment.endLine ?? comment.lineNumber
  const isRange = endLine > comment.lineNumber

  return (
    <div className={`comment-bubble ${isResolved ? 'comment-resolved' : ''}`} id={`comment-${comment.id}`}>
      <div className="comment-bubble-header">
        <UserCircle size={18} className="comment-bubble-avatar" />
        {isRange && (
          <span className="comment-bubble-range" title={`Lines ${comment.lineNumber}–${endLine}`}>
            L{comment.lineNumber}–L{endLine}
          </span>
        )}
        <span className="comment-bubble-time">{timeAgo(comment.createdAt)}</span>
        {isResolved && (
          <span className="comment-bubble-resolved">
            <CheckCircle2 size={14} />
            Resolved
          </span>
        )}
        {!isResolved && (
          <button
            className="comment-bubble-delete"
            onClick={() => onDelete(comment.id)}
            title="Delete comment"
          >
            &times;
          </button>
        )}
      </div>
      <div className="comment-bubble-body">{comment.body}</div>
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
