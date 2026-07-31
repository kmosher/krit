import { useEffect, useRef, useState } from 'react'

interface QueuedCommentEditorProps {
  initialBody: string
  // Resolves when the rewrite is stored. The editor stays open until then and
  // keeps the text if it rejects — a refusal is exactly when the reviewer needs
  // what they typed to still be on screen.
  onSave: (body: string) => Promise<void> | void
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
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
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

  const save = async () => {
    const trimmed = body.trim()
    // An empty body would leave a comment with nothing in it but its anchor,
    // which reads as a rendering bug. Deleting the comment is the other button.
    if (!trimmed || saving) return
    setSaveFailed(false)
    setSaving(true)
    try {
      await onSave(trimmed)
    } catch {
      // The reason is reported by the caller's error path; this only has to
      // keep the text alive and say the save did not take. The commonest cause
      // is losing the race against "Post queued", after which the comment is no
      // longer editable at all — hence "copy it somewhere" rather than "retry".
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
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
            void save()
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
      {saveFailed && (
        <div className="comment-form-confirm" role="alert">
          <span>That didn’t save — your text is still here. Copy it before closing.</span>
        </div>
      )}
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
          disabled={!body.trim() || !edited || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
