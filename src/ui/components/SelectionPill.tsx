import { useLayoutEffect, useRef, useState } from 'react'
import { MessageSquare, X } from 'lucide-react'

interface SelectionPillProps {
  // Viewport coordinates (from Range.getBoundingClientRect(), which resolves
  // correctly even for a shadow-DOM-internal Range — see selectionMapping.ts).
  // Positioned at the selection's end, per the design.
  x: number
  y: number
  onComment: () => void
  // Omitted by the rendered-document preview, where a selection's source range
  // can be a superset of what was highlighted (previewAnchor.ts snaps outward
  // when it cannot locate the text exactly). Commenting on slightly too much
  // is harmless; deleting slightly too much is not.
  onDelete?: () => void
}

// Floats at the end of a native text selection inside the code surface,
// offering "Comment" (opens a character-anchored draft) and "Delete"
// (splices the selected text out of the working-tree file directly — see
// CodeViewWrapper's onDeleteRange). Fixed-position so it isn't affected by
// CodeView's own internal scroll virtualization.
export function SelectionPill({ x, y, onComment, onDelete }: SelectionPillProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // A selection ending near the pane edge puts the raw anchor point outside
  // (or half outside) the viewport. Clamp after measuring the rendered size;
  // useLayoutEffect runs pre-paint, so the unclamped position never flashes.
  // Near the bottom edge, flip above the anchor instead of just clamping so
  // the pill doesn't cover the selection's last line.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const MARGIN = 8
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(MARGIN, Math.min(x, window.innerWidth - w - MARGIN))
    let top = y
    if (top + h > window.innerHeight - MARGIN) top = y - h - 28
    setPos({ left, top: Math.max(MARGIN, top) })
  }, [x, y])

  return (
    <div
      ref={ref}
      className="selection-pill"
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      // mousedown is where browsers clear a selection on click-elsewhere.
      // The anchor was already captured when the drag ended, so nothing here
      // depends on the selection surviving — but the reviewer is looking at
      // the highlight they are about to comment on, and it should still be
      // there while they aim at the button.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className="selection-pill-btn" onClick={onComment} title="Comment on this selection">
        <MessageSquare size={13} />
        Comment
      </button>
      {onDelete && (
        <button type="button" className="selection-pill-btn selection-pill-btn-danger" onClick={onDelete} title="Delete this selection from the file">
          <X size={13} />
          Delete
        </button>
      )}
    </div>
  )
}
