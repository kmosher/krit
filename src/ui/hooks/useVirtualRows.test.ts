import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { computeRowWindow, useVirtualRows } from './useVirtualRows'

describe('computeRowWindow', () => {
  const ITEMS = 1000
  const ROW = 20

  it('renders the top slice plus overscan when scrolled to the top', () => {
    // viewport 200px / 20px = 10 rows visible, +3 overscan below.
    const w = computeRowWindow(ITEMS, ROW, 3, 0, 0, 200)
    expect(w.startIndex).toBe(0)
    expect(w.endIndex).toBe(13)
    expect(w.totalHeight).toBe(ITEMS * ROW)
    expect(w.offsetY).toBe(0)
  })

  it('windows to the scrolled region with overscan on both sides', () => {
    // scrollTop 1000px -> row 50; 200px viewport -> rows 50..60; overscan 3.
    const w = computeRowWindow(ITEMS, ROW, 3, 0, 1000, 200)
    expect(w.startIndex).toBe(47)
    expect(w.endIndex).toBe(63)
    expect(w.offsetY).toBe(47 * ROW)
  })

  it('clamps startIndex at 0 and endIndex at itemCount at the extremes', () => {
    const top = computeRowWindow(ITEMS, ROW, 5, 0, 0, 200)
    expect(top.startIndex).toBe(0)
    const bottom = computeRowWindow(ITEMS, ROW, 5, 0, ITEMS * ROW, 200)
    expect(bottom.endIndex).toBe(ITEMS)
  })

  it('subtracts headerOffset before mapping scrollTop to a row', () => {
    // A 40px header shares the scroll container: 40px of scroll is still row 0.
    const w = computeRowWindow(ITEMS, ROW, 0, 40, 40, 200)
    expect(w.startIndex).toBe(0)
    // Same physical scroll without the offset would start one row in.
    const noOffset = computeRowWindow(ITEMS, ROW, 0, 0, 40, 200)
    expect(noOffset.startIndex).toBe(2)
  })

  it('produces an empty window for zero items', () => {
    const w = computeRowWindow(0, ROW, 3, 0, 0, 200)
    expect(w.startIndex).toBe(0)
    expect(w.endIndex).toBe(0)
    expect(w.totalHeight).toBe(0)
  })
})

// Smoke test that the hook itself mounts under happy-dom + Testing Library —
// proves the component/hook test path works, not just pure functions. Before a
// scroll or measurement, it reports a valid (top, zero-height-viewport) window.
describe('useVirtualRows (hook)', () => {
  it('mounts and returns a coherent initial window and stable handles', () => {
    const { result } = renderHook(() =>
      useVirtualRows({ itemCount: 100, rowHeight: 20, overscan: 4 }),
    )
    expect(result.current.startIndex).toBe(0)
    expect(result.current.totalHeight).toBe(2000)
    expect(result.current.offsetY).toBe(0)
    expect(typeof result.current.onScroll).toBe('function')
    expect(result.current.scrollRef).toBeDefined()
  })
})
