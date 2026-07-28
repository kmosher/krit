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

/// Round-trips through localStorage. A corrupt or out-of-range stored value
/// reads as the default rather than reproducing a broken layout the user
/// cannot see the cause of.
export function parseStoredFraction(raw: string | null): number {
  if (raw == null) return DEFAULT_TRACKER_FRACTION
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? clampFraction(parsed) : DEFAULT_TRACKER_FRACTION
}

const KEYBOARD_STEP = 0.05

interface SidebarSplitterProps {
  fraction: number
  onChange: (fraction: number) => void
  /** Measured on drag start — the flex container both panes live in. */
  containerRef: React.RefObject<HTMLElement | null>
}

export function SidebarSplitter({ fraction, onChange, containerRef }: SidebarSplitterProps) {
  const draggingRef = useRef(false)

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      onChange(fractionFromPointer(e.clientY, rect))
    },
    [containerRef, onChange],
  )

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true
    // Capture so a fast drag that outruns the 6px handle keeps sending moves
    // here instead of to whatever the pointer happens to be over.
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowUp') onChange(clampFraction(fraction + KEYBOARD_STEP))
      else if (e.key === 'ArrowDown') onChange(clampFraction(fraction - KEYBOARD_STEP))
      else if (e.key === 'Home') onChange(MAX_TRACKER_FRACTION)
      else if (e.key === 'End') onChange(MIN_TRACKER_FRACTION)
      else return
      e.preventDefault()
    },
    [fraction, onChange],
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
      onDoubleClick={() => onChange(DEFAULT_TRACKER_FRACTION)}
      title="Drag to resize — double-click to reset"
    >
      <div className="sidebar-splitter-grip" />
    </div>
  )
}
