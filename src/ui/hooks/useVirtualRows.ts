import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { DependencyList, RefObject, UIEvent } from 'react'

// Fixed-row-height windowing, shared by FileTree and CommentTracker: both
// hand-rolled the same scrollTop state + onScroll handler, a
// ResizeObserver-driven viewport-height effect, and the same
// startIndex/endIndex formula before this was pulled out.

export interface UseVirtualRowsOptions {
  /** Total row count before windowing. */
  itemCount: number
  /** Fixed per-row height in px — every row must render at exactly this
   *  height for the index math below to line up with the real scroll. */
  rowHeight: number
  /** Extra rows rendered above/below the visible window, so a fast scroll
   *  or a slightly-late measurement doesn't flash empty space. */
  overscan: number
  /** Px to subtract from `scrollTop` before converting it to a row index —
   *  for a scroll container that also holds a non-virtualized header above
   *  the row list (e.g. CommentTracker's counts bar sits inside the same
   *  scroll region). Leave at 0 when the row list *is* the whole scroll
   *  container (e.g. FileTree's search bar lives outside `scrollRef`). */
  headerOffset?: number
  /** Extra effect dependencies that force a viewport-height re-measure,
   *  beyond the automatic ResizeObserver (e.g. a sidebar-collapse toggle
   *  that changes layout without resizing the scroller itself). */
  resizeDeps?: DependencyList
}

export interface UseVirtualRowsResult {
  /** Attach to the scrollable element. */
  scrollRef: RefObject<HTMLDivElement | null>
  /** Attach to the scrollable element's `onScroll`. */
  onScroll: (e: UIEvent<HTMLDivElement>) => void
  /** First index (inclusive) of `[startIndex, endIndex)` to render. */
  startIndex: number
  /** Last index (exclusive) to render. */
  endIndex: number
  /** `itemCount * rowHeight` — set as the row list's total scrollable
   *  height (a `position: relative` container sized to the full list, with
   *  each rendered row absolutely positioned inside it). */
  totalHeight: number
  /** Pixel top of `startIndex` — add `i * rowHeight` for row `i` within the
   *  rendered slice, i.e. `top: offsetY + i * rowHeight`. */
  offsetY: number
}

const NO_EXTRA_DEPS: DependencyList = []

export function useVirtualRows({
  itemCount,
  rowHeight,
  overscan,
  headerOffset = 0,
  resizeDeps = NO_EXTRA_DEPS,
}: UseVirtualRowsOptions): UseVirtualRowsResult {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  // Track the scroller's viewport height so the visible-row window can be
  // computed. Re-measures on resize (e.g. window resize, sidebar toggle) and
  // whenever a caller-supplied dependency changes.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resizeDeps)

  const listScrollTop = Math.max(0, scrollTop - headerOffset)
  const startIndex = Math.max(0, Math.floor(listScrollTop / rowHeight) - overscan)
  const endIndex = Math.min(
    itemCount,
    Math.ceil((listScrollTop + viewportHeight) / rowHeight) + overscan,
  )

  return {
    scrollRef,
    onScroll,
    startIndex,
    endIndex,
    totalHeight: itemCount * rowHeight,
    offsetY: startIndex * rowHeight,
  }
}
