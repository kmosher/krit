import { MessageSquare, X } from 'lucide-react'

interface SelectionPillProps {
  // Viewport coordinates (from Range.getBoundingClientRect(), which resolves
  // correctly even for a shadow-DOM-internal Range — see selectionMapping.ts).
  // Positioned at the selection's end, per the design.
  x: number
  y: number
  onComment: () => void
  onDelete: () => void
}

// Floats at the end of a native text selection inside the code surface,
// offering "Comment" (opens a character-anchored draft) and "Delete"
// (splices the selected text out of the working-tree file directly — see
// CodeViewWrapper's onDeleteRange). Fixed-position so it isn't affected by
// CodeView's own internal scroll virtualization.
export function SelectionPill({ x, y, onComment, onDelete }: SelectionPillProps) {
  return (
    <div
      className="selection-pill"
      style={{ position: 'fixed', left: x, top: y }}
      // Selecting again inside the pill (e.g. clicking) shouldn't collapse
      // the underlying text selection before the click handler reads it —
      // mousedown is where browsers normally clear a selection on
      // click-elsewhere, so stop it here specifically.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className="selection-pill-btn" onClick={onComment} title="Comment on this selection">
        <MessageSquare size={13} />
        Comment
      </button>
      <button type="button" className="selection-pill-btn selection-pill-btn-danger" onClick={onDelete} title="Delete this selection from the file">
        <X size={13} />
        Delete
      </button>
    </div>
  )
}
