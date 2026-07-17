// Maps a native browser text selection made inside @pierre/diffs' rendered
// code surface to a (line, column) character anchor diffx can persist.
//
// Two things make this non-obvious rather than "just use Range APIs":
//
// 1. CodeView renders into an *open* shadow root (confirmed by reading
//    @pierre/diffs' dist output — FileStream.js calls
//    `container.attachShadow({ mode: 'open' })`). The standard
//    `document.getSelection()` retargets a shadow-internal selection's
//    anchor/focus nodes to the shadow *host* rather than the real text
//    node, which throws away the offsets we need. Chrome (only) exposes
//    `ShadowRoot.getSelection()` as a non-standard extension that returns
//    the real, untargeted selection — we use that when available and fall
//    back to `document.getSelection()` otherwise (Firefox/Safari will only
//    get line-level granularity worst case, not a crash).
// 2. Each rendered line's container carries `data-line="<lineNumber>"`
//    (confirmed in @pierre/diffs' createRowNodes.js / FileStream.js), but
//    the text inside it is wrapped in nested `<span>`s for syntax
//    highlighting — so a raw `Range.startOffset` isn't "column within the
//    line," it's "offset within whichever span the selection happened to
//    land in." We compute the true column with the standard
//    range-to-string-length trick: build a Range from the line container's
//    start to the selection point and take `.toString().length` — that
//    concatenates all text content in document order regardless of markup,
//    matching what the reviewer visually selected.

export interface SelectionAnchor {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  selectedText: string
}

function getShadowAwareSelection(target: Node | null): Selection | null {
  const root = target?.getRootNode?.()
  if (root instanceof ShadowRoot) {
    const shadowGetSelection = (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection
    if (typeof shadowGetSelection === 'function') {
      const sel = shadowGetSelection.call(root)
      if (sel) return sel
    }
  }
  return document.getSelection()
}

// Returns the active selection's Range, using the shadow-aware lookup
// above, seeded from the node an originating event touched (its
// composedPath()[0] is the deepest — possibly shadow-internal — target,
// which is what tells us which shadow root to ask).
export function getActiveSelectionRange(eventTarget: EventTarget | null): Range | null {
  const node = eventTarget instanceof Node ? eventTarget : null
  const sel = getShadowAwareSelection(node)
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  return sel.getRangeAt(0)
}

function closestLineElement(node: Node): HTMLElement | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
  return el?.closest?.('[data-line]') ?? null
}

function columnWithinLine(lineEl: HTMLElement, node: Node, offset: number): number | null {
  try {
    const r = document.createRange()
    r.setStart(lineEl, 0)
    r.setEnd(node, offset)
    return r.toString().length
  } catch {
    // setEnd throws if `node` isn't actually a descendant of `lineEl` (e.g.
    // the selection end landed outside any [data-line] container) —
    // treat as unmappable rather than guessing.
    return null
  }
}

// Maps a Range to a character anchor. Returns null if either endpoint
// isn't inside a rendered code line (data-line ancestor missing) or the
// mapping is otherwise inconsistent — callers should treat that as "don't
// show the selection pill" rather than persisting a guessed range.
export function mapRangeToAnchor(range: Range): SelectionAnchor | null {
  const startLineEl = closestLineElement(range.startContainer)
  const endLineEl = closestLineElement(range.endContainer)
  if (!startLineEl || !endLineEl) return null

  const startLineAttr = startLineEl.dataset.line
  const endLineAttr = endLineEl.dataset.line
  if (!startLineAttr || !endLineAttr) return null
  const startLine = Number(startLineAttr)
  const endLine = Number(endLineAttr)
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return null

  const startColumn = columnWithinLine(startLineEl, range.startContainer, range.startOffset)
  const endColumn = columnWithinLine(endLineEl, range.endContainer, range.endOffset)
  if (startColumn === null || endColumn === null) return null

  const selectedText = range.toString()
  if (selectedText.length === 0) return null

  // Range should already be start-before-end (Selection.getRangeAt(0)
  // normalizes forward/backward drags), but guard anyway — a caller
  // feeding in an arbitrary Range shouldn't be able to produce an inverted
  // anchor.
  if (startLine > endLine || (startLine === endLine && startColumn > endColumn)) {
    return { startLine: endLine, startColumn: endColumn, endLine: startLine, endColumn: startColumn, selectedText }
  }
  return { startLine, startColumn, endLine, endColumn, selectedText }
}
