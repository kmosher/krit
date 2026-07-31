import { useEffect, useRef, useState } from 'react'

interface QueuedCommentEditorProps {
  initialBody: string
  onSave: (body: string) => void
  onCancel: () => void
}

/**
 * Rewrite a queued comment's text in place.
 *
 * Deliberately not `CommentForm`: that form composes a *new* comment and owns a
 * suggest-rewrite editor seeded from the file's lines, none of which applies to
 * text that is already a comment — and the update route carries only the body,
 * so a suggestion typed here would be silently dropped on save.
 */
export function QueuedCommentEditor({ initialBody, onSave, onCancel }: QueuedCommentEditorProps) {
  const [body, setBody] = useState(initialBody)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Caret at the end rather than over the text: this opens on words the
    // reviewer already wrote, and selecting them all makes the first keystroke
    // delete the comment they meant to amend.
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const edited = body !== initialBody

  // The single exit, so no path drops an edit without asking — the rule
  // CommentForm's requestCancel and FileEditorModal's requestClose follow. An
  // inline strip rather than confirm(), which would freeze the page for
  // anything driving the browser.
  const requestCancel = () => {
    if (edited) {
      setConfirmingDiscard(true)
      return
    }
    onCancel()
  }

  const save = () => {
    const trimmed = body.trim()
    // An empty body would leave a comment with nothing in it but its anchor,
    // which reads as a rendering bug. Deleting the comment is the other button.
    if (!trimmed) return
    onSave(trimmed)
  }

  return (
    <div className="queued-editor">
      <textarea
        ref={ref}
        className="queued-editor-input"
        value={body}
        rows={3}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            save()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            // A second Escape answers the strip: asking a question the keyboard
            // cannot answer is the same dead end a native dialog would be.
            if (confirmingDiscard) {
              setConfirmingDiscard(false)
              onCancel()
              return
            }
            requestCancel()
          }
        }}
        aria-label="Edit queued comment"
      />
      {confirmingDiscard && (
        <div className="comment-form-confirm" role="alert">
          <span>Discard your changes?</span>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              setConfirmingDiscard(false)
              onCancel()
            }}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setConfirmingDiscard(false)}
          >
            Keep editing
          </button>
        </div>
      )}
      <div className="queued-editor-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={requestCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={save}
          disabled={!body.trim() || !edited}
        >
          Save
        </button>
      </div>
    </div>
  )
}
