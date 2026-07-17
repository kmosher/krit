import { useEffect } from 'react'

const AUTO_DISMISS_MS = 8000

interface UndoToastProps {
  message: string
  onUndo: () => void
  onDismiss: () => void
}

// Bottom-corner toast for a direct-delete edit (see CodeViewWrapper's
// onDeleteRange). Auto-dismisses after AUTO_DISMISS_MS — the server-side
// undo buffer entry outlives the toast (cap 20, not time-boxed), but once
// the toast is gone there's no UI left pointing at that specific undo id,
// so losing the chance to click it here is effectively losing the undo.
export function UndoToast({ message, onUndo, onDismiss }: UndoToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <div className="undo-toast">
      <span className="undo-toast-message">{message}</span>
      <button type="button" className="undo-toast-btn" onClick={onUndo}>
        Undo
      </button>
      <button type="button" className="undo-toast-dismiss" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
