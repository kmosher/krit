import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createElement } from 'react'
import { fireEvent, render as renderDom, renderHook } from '@testing-library/react'
import { computeRowWindow, useVirtualRows } from './useVirtualRows'
import type { UseVirtualRowsResult } from './useVirtualRows'

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
    // A 40px header shares the scroll container: 40px of scroll is still row 0,
    // and the visible span still ends 200px later, at row 10.
    const w = computeRowWindow(ITEMS, ROW, 0, 40, 40, 200)
    expect(w.startIndex).toBe(0)
    expect(w.endIndex).toBe(10)
    // Same physical scroll without the offset would start one row in.
    const noOffset = computeRowWindow(ITEMS, ROW, 0, 0, 40, 200)
    expect(noOffset.startIndex).toBe(2)
  })

  it('clamps a scrollTop above the row list to zero, not to a negative span', () => {
    // Resting at the very top of a container with a 40px header: the list has
    // not scrolled at all. Without the clamp the span starts 40px negative and
    // endIndex comes up two rows short of the viewport, at the top of every
    // diff — startIndex's own clamp hides it.
    const w = computeRowWindow(ITEMS, ROW, 0, 40, 0, 200)
    expect(w.startIndex).toBe(0)
    expect(w.endIndex).toBe(10)
    expect(w.offsetY).toBe(0)
  })

  it('produces an empty window for zero items', () => {
    const w = computeRowWindow(0, ROW, 3, 0, 0, 200)
    expect(w.startIndex).toBe(0)
    expect(w.endIndex).toBe(0)
    expect(w.totalHeight).toBe(0)
  })

  it('returns a finite empty window when the row height is not yet measured', () => {
    // estimateWrappedRowHeight returns 0 off an unpainted surface; dividing by
    // it would put NaN in every field and blank the list for good.
    const w = computeRowWindow(ITEMS, 0, 3, 0, 500, 200)
    for (const v of [w.startIndex, w.endIndex, w.totalHeight, w.offsetY]) {
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(w.endIndex).toBe(0)
    expect(w.totalHeight).toBe(0)
  })
})

describe('useVirtualRows (hook)', () => {
  const render = () =>
    renderHook(() => useVirtualRows({ itemCount: 100, rowHeight: 20, overscan: 4 }))

  it('starts at index 0 with full totalHeight before any scroll or measurement', () => {
    const { result } = render()
    expect(result.current.startIndex).toBe(0)
    expect(result.current.offsetY).toBe(0)
    expect(result.current.totalHeight).toBe(2000)
  })

  it('keeps onScroll and scrollRef identities stable across re-renders', () => {
    const { result, rerender } = render()
    const { onScroll, scrollRef } = result.current
    rerender()
    expect(result.current.onScroll).toBe(onScroll)
    expect(result.current.scrollRef).toBe(scrollRef)
  })
})

// The half that only exists with a real element attached: the ref feeding the
// viewport measurement, and the scroll handler feeding scrollTop. happy-dom
// lays nothing out, so clientHeight is stubbed on the prototype — that is the
// one value the hook reads off the DOM.
describe('useVirtualRows (attached to a scroller)', () => {
  const VIEWPORT = 200
  let originalClientHeight: PropertyDescriptor | undefined

  beforeAll(() => {
    originalClientHeight = Object.getOwnPropertyDescriptor(
      window.HTMLElement.prototype,
      'clientHeight',
    )
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => VIEWPORT,
    })
  })

  afterAll(() => {
    if (originalClientHeight) {
      Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', originalClientHeight)
    } else {
      // @ts-expect-error deleting a stub we added ourselves
      delete window.HTMLElement.prototype.clientHeight
    }
  })

  function mount() {
    let latest!: UseVirtualRowsResult
    function Scroller() {
      const v = useVirtualRows({ itemCount: 100, rowHeight: 20, overscan: 4 })
      latest = v
      return createElement('div', { ref: v.scrollRef, onScroll: v.onScroll, 'data-testid': 'sc' })
    }
    const { getByTestId } = renderDom(createElement(Scroller))
    return { el: getByTestId('sc'), current: () => latest }
  }

  it('measures the scroller and windows to its height', () => {
    // Without the measurement viewportHeight stays 0 and only the overscan
    // rows render, i.e. an empty list below the fold.
    expect(mount().current().endIndex).toBe(VIEWPORT / 20 + 4)
  })

  it('follows the element scrollTop', () => {
    const { el, current } = mount()
    el.scrollTop = 1000
    fireEvent.scroll(el)
    // Row 50 is at the top; overscan 4 above it.
    expect(current().startIndex).toBe(46)
    expect(current().offsetY).toBe(46 * 20)
    expect(current().endIndex).toBe(64)
  })
})
