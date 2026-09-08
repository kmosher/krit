import { useEffect, useRef } from 'react'
import { Unlink, X } from 'lucide-react'
import type { ReviewComment } from '../../types'
import { CommentBubble } from './CommentBubble'

interface Props {
  filePath: string
  // Every comment stranded on this file, oldest first — the order they were
  // written in, which is the order the thread reads in.
  comments: ReviewComment[]
  // The one the reviewer clicked in the tracker; scrolled to on open.
  focusId: string
  onClose: () => void
  onDelete: (id: string) => void
  onReply: (id: string, body: string) => void
  onEdit?: (id: string, body: string) => Promise<void> | void
}

export function OrphanCommentPanel({
  filePath,
  comments,
  focusId,
  onClose,
  onDelete,
  onReply,
  onEdit,
}: Props) {
  const focusRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: 'center' })
  }, [focusId])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="orphan-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="orphan-panel" role="dialog" aria-label={`Comments on ${filePath}`}>
        <div className="orphan-panel-header">
          <Unlink size={14} />
          <span className="orphan-panel-path">{filePath}</span>
          <button className="orphan-panel-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="orphan-panel-note">
          Not in the diff any more — usually because the agent rewrote it back to what HEAD already
          has. The thread is still live: replies land here and you can answer them.
        </div>
        <div className="orphan-panel-body">
          {comments.map((comment) => (
            <div
              key={comment.id}
              ref={comment.id === focusId ? focusRef : undefined}
              className="orphan-panel-thread"
            >
              <div className="orphan-panel-anchor">
                <span className="orphan-panel-line">
                  {comment.filePath}:{comment.lineNumber}
                  {comment.endLine && comment.endLine > comment.lineNumber
                    ? `–${comment.endLine}`
                    : ''}
                </span>
                {/* The code the comment was written against. It is the only
                    copy left on screen once the file is out of the diff, so it
                    is shown even though a bubble on the surface would not. */}
                {comment.lineContent && (
                  <pre className="orphan-panel-code">{comment.lineContent}</pre>
                )}
              </div>
              <CommentBubble
                comment={comment}
                onDelete={onDelete}
                onReply={onReply}
                onEdit={onEdit}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
