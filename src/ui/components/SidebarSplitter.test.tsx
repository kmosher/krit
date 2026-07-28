import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createRef } from 'react'
import {
  SidebarSplitter,
  clampFraction,
  fractionFromPointer,
  parseStoredFraction,
  DEFAULT_TRACKER_FRACTION,
  MIN_TRACKER_FRACTION,
  MAX_TRACKER_FRACTION,
} from './SidebarSplitter'

describe('clampFraction', () => {
  it('keeps both panes usable at the extremes', () => {
    // Dragging to the very edge otherwise leaves a pane a few pixels tall,
    // with the handle buried in a corner and no obvious way back.
    expect(clampFraction(0)).toBe(MIN_TRACKER_FRACTION)
    expect(clampFraction(1)).toBe(MAX_TRACKER_FRACTION)
  })

  it('passes ordinary values through untouched', () => {
    expect(clampFraction(0.42)).toBe(0.42)
  })

  it('falls back to the default for NaN rather than producing an unstyled pane', () => {
    // Non-finite means the measurement itself was meaningless, so there is no
    // "nearest edge" to clamp to — fall back rather than guess.
    expect(clampFraction(Number.NaN)).toBe(DEFAULT_TRACKER_FRACTION)
    expect(clampFraction(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TRACKER_FRACTION)
  })
})

describe('fractionFromPointer', () => {
  const rect = { top: 100, height: 400 } // bottom edge at 500

  it('grows the tracker as the pointer moves up, since it is the bottom pane', () => {
    expect(fractionFromPointer(300, rect)).toBeCloseTo(0.5)
    expect(fractionFromPointer(200, rect)).toBeCloseTo(0.75)
  })

  it('measures from the bottom edge, not the top', () => {
    // Getting this backwards makes the divider run away from the pointer,
    // which is the classic splitter bug.
    expect(fractionFromPointer(150, rect)).toBeGreaterThan(fractionFromPointer(450, rect))
  })

  it('clamps a pointer dragged past either edge', () => {
    expect(fractionFromPointer(-1000, rect)).toBe(MAX_TRACKER_FRACTION)
    expect(fractionFromPointer(9999, rect)).toBe(MIN_TRACKER_FRACTION)
  })

  it('survives a zero-height container instead of dividing by zero', () => {
    expect(fractionFromPointer(0, { top: 0, height: 0 })).toBe(DEFAULT_TRACKER_FRACTION)
  })
})

describe('parseStoredFraction', () => {
  it('restores a previously saved split', () => {
    expect(parseStoredFraction('0.35')).toBeCloseTo(0.35)
  })

  it('uses the default when nothing was saved', () => {
    expect(parseStoredFraction(null)).toBe(DEFAULT_TRACKER_FRACTION)
  })

  it('ignores a corrupt stored value rather than reproducing a broken layout', () => {
    // localStorage is shared with anything else on this origin and survives
    // upgrades, so a garbage value has to be survivable.
    expect(parseStoredFraction('not-a-number')).toBe(DEFAULT_TRACKER_FRACTION)
    expect(parseStoredFraction('')).toBe(DEFAULT_TRACKER_FRACTION)
  })

  it('clamps an out-of-range stored value', () => {
    expect(parseStoredFraction('5')).toBe(MAX_TRACKER_FRACTION)
    expect(parseStoredFraction('-5')).toBe(MIN_TRACKER_FRACTION)
  })
})

function renderSplitter(onChange = vi.fn(), onCommit = vi.fn()) {
  const ref = createRef<HTMLElement>()
  const utils = render(
    <div ref={ref as React.RefObject<HTMLDivElement>}>
      <SidebarSplitter
        fraction={0.5}
        onChange={onChange}
        onCommit={onCommit}
        containerRef={ref}
      />
    </div>,
  )
  const handle = screen.getByRole('separator')
  vi.spyOn(ref.current!, 'getBoundingClientRect').mockReturnValue({
    top: 100,
    height: 400,
    bottom: 500,
    left: 0,
    right: 0,
    width: 300,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  })
  // happy-dom does not implement pointer capture.
  handle.setPointerCapture = vi.fn()
  handle.hasPointerCapture = vi.fn(() => false)
  handle.releasePointerCapture = vi.fn()
  return { ...utils, handle, onChange, onCommit }
}

describe('SidebarSplitter', () => {
  it('reports a new split while dragging', () => {
    const { handle, onChange } = renderSplitter()
    fireEvent.pointerDown(handle, { pointerId: 1 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 })
    expect(onChange).toHaveBeenCalledWith(0.75)
  })

  it('ignores pointer movement when no drag is in progress', () => {
    // The handle sits under the pointer whenever the mouse crosses the
    // sidebar; reacting to that would resize on a passing hover.
    const { handle, onChange } = renderSplitter()
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stops resizing once the pointer is released', () => {
    const { handle, onChange } = renderSplitter()
    fireEvent.pointerDown(handle, { pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 150 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is adjustable from the keyboard', () => {
    // A drag handle that only responds to a mouse is unreachable for anyone
    // navigating by keyboard, and unusable from an automated session.
    const { handle, onChange } = renderSplitter()
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenCalledWith(0.55)
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith(0.45)
  })

  it('leaves unrelated keys to the page', () => {
    const { handle, onChange } = renderSplitter()
    fireEvent.keyDown(handle, { key: 'a' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('resets to an even split on double-click', () => {
    const { handle, onChange } = renderSplitter()
    fireEvent.doubleClick(handle)
    expect(onChange).toHaveBeenCalledWith(DEFAULT_TRACKER_FRACTION)
  })

  it('exposes its position to assistive tech', () => {
    const { handle } = renderSplitter()
    expect(handle.getAttribute('aria-valuenow')).toBe('50')
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal')
  })

  it('commits once when the gesture ends, not on every sample', () => {
    // Persistence hangs off onCommit. localStorage.setItem is synchronous, so
    // a write per pointer sample would put a disk write between each frame of
    // the resize it is animating.
    const { handle, onCommit } = renderSplitter()
    fireEvent.pointerDown(handle, { pointerId: 1 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 300 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(0.75)
  })

  it('commits a keyboard adjustment immediately', () => {
    // A key press is a whole gesture on its own — there is no "up" to wait for,
    // so deferring the write would drop it entirely.
    const { handle, onCommit } = renderSplitter()
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(onCommit).toHaveBeenCalledWith(0.55)
  })

  it('ignores a second pointer while one is already dragging', () => {
    // Otherwise a second contact takes over the drag and whichever pointer
    // lifts first ends it for both, stranding the one still held down.
    const { handle, onChange, onCommit } = renderSplitter()
    fireEvent.pointerDown(handle, { pointerId: 1 })
    fireEvent.pointerDown(handle, { pointerId: 2 })
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 200 })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerUp(handle, { pointerId: 2 })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 })
    expect(onChange).toHaveBeenCalledWith(0.75)
  })
})
