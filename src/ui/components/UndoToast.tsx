import { useEffect, useRef } from 'react'

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
  // onDismiss is typically a fresh inline closure from the parent on every
  // render (App re-renders often -- comments alone poll every 3s). Keying
  // the effect on it would clear+reschedule the timer on every one of
  // those renders, so a toast could sit past AUTO_DISMISS_MS without ever
  // actually firing its dismissal. Read the latest callback through a ref
  // instead, so the timer is set exactly once, on mount.
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  useEffect(() => {
    const timer = setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [])

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
