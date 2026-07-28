import { useCallback, useRef } from 'react'

// How much of the sidebar the comment tracker may occupy. Held as a fraction
// rather than pixels so the split survives a window resize, and applied as a
// *max* height (see .ct in global.css): a short comment list still shrinks to
// its content and hands the slack to the file tree, which is the common case.
export const DEFAULT_TRACKER_FRACTION = 0.5

// Both panes stay big enough to be worth having. Without a floor, one drag to
// the edge leaves a pane a few pixels tall with no obvious way back.
export const MIN_TRACKER_FRACTION = 0.15
export const MAX_TRACKER_FRACTION = 0.85

export function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TRACKER_FRACTION
  return Math.min(MAX_TRACKER_FRACTION, Math.max(MIN_TRACKER_FRACTION, value))
}

/// The tracker is the *bottom* pane, so its share grows as the pointer moves
/// up — measured from the bottom edge, not the top.
export function fractionFromPointer(clientY: number, rect: { top: number; height: number }): number {
  if (rect.height <= 0) return DEFAULT_TRACKER_FRACTION
  return clampFraction((rect.top + rect.height - clientY) / rect.height)
}

/// Parses the value App.tsx read out of localStorage (it owns the key and the
/// storage access). A corrupt or out-of-range value reads as the default
/// rather than reproducing a broken layout the user cannot see the cause of.
export function parseStoredFraction(raw: string | null): number {
  if (raw == null) return DEFAULT_TRACKER_FRACTION
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? clampFraction(parsed) : DEFAULT_TRACKER_FRACTION
}

const KEYBOARD_STEP = 0.05

interface SidebarSplitterProps {
  fraction: number
  /** Fires continuously during a drag, so the layout tracks the pointer. */
  onChange: (fraction: number) => void
  /**
   * Fires once the gesture is over. Persistence hangs off this rather than
   * off onChange: a drag emits a fraction per pointer sample, and
   * localStorage.setItem is synchronous, so writing on every one of them puts
   * a disk write between each frame of the resize it is trying to animate.
   */
  onCommit: (fraction: number) => void
  /** Measured on drag start — the flex container both panes live in. */
  containerRef: React.RefObject<HTMLElement | null>
}

export function SidebarSplitter({
  fraction,
  onChange,
  onCommit,
  containerRef,
}: SidebarSplitterProps) {
  // The active pointer's id, not a boolean: a second contact (a stylus while a
  // mouse button is down, or a second finger) would otherwise take over the
  // drag, and whichever pointer lifted first would end it for both.
  const draggingRef = useRef<number | null>(null)
  const latestRef = useRef(fraction)

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (draggingRef.current !== e.pointerId) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      latestRef.current = fractionFromPointer(e.clientY, rect)
      onChange(latestRef.current)
    },
    [containerRef, onChange],
  )

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current !== null) return
    draggingRef.current = e.pointerId
    // Without this the browser claims the gesture for scrolling on touch, and
    // on mouse the drag paints a text selection across the tree and the
    // comment list — which krit's own selection-to-comment plumbing then sees.
    e.preventDefault()
    // Capture so a fast drag that outruns the handle keeps sending moves here
    // instead of to whatever the pointer happens to be over.
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (draggingRef.current !== e.pointerId) return
      draggingRef.current = null
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      onCommit(latestRef.current)
    },
    [onCommit],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      let next: number
      if (e.key === 'ArrowUp') next = clampFraction(fraction + KEYBOARD_STEP)
      else if (e.key === 'ArrowDown') next = clampFraction(fraction - KEYBOARD_STEP)
      else if (e.key === 'Home') next = MAX_TRACKER_FRACTION
      else if (e.key === 'End') next = MIN_TRACKER_FRACTION
      else return
      e.preventDefault()
      latestRef.current = next
      onChange(next)
      // A key press is its own complete gesture — there is no "up" to wait for.
      onCommit(next)
    },
    [fraction, onChange, onCommit],
  )

  return (
    <div
      className="sidebar-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize comment list"
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuemin={Math.round(MIN_TRACKER_FRACTION * 100)}
      aria-valuemax={Math.round(MAX_TRACKER_FRACTION * 100)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => {
        latestRef.current = DEFAULT_TRACKER_FRACTION
        onChange(DEFAULT_TRACKER_FRACTION)
        onCommit(DEFAULT_TRACKER_FRACTION)
      }}
      title="Drag to resize — double-click to reset"
    >
      <div className="sidebar-splitter-grip" />
    </div>
  )
}
