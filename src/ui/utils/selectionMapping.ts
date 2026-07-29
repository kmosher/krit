// Maps a mouse drag over @pierre/diffs' rendered code surface to a
// (line, column) character anchor krit can persist.
//
// The anchor is derived from the drag's own pointer coordinates, resolved by
// the browser's hit-testing via `document.caretPositionFromPoint(x, y,
// { shadowRoots: [root] })`, rather than from the Selection API.
//
// CodeView renders into an open shadow root (FileStream.js calls
// `attachShadow({ mode: 'open' })`), and reading a selection back across
// that boundary took a different API per engine: `document.getSelection()`
// retargets both endpoints to the shadow host, Chrome exposes a non-standard
// `ShadowRoot.getSelection()`, and `Selection.getComposedRanges()` — the
// standard answer, and the one @pierre/diffs itself uses upstream — shipped
// in two call signatures. Choosing between them meant detecting retargeting
// by hand, and the retargeted view of a real selection is misleading in ways
// that are easy to build on by accident: a multi-character shadow-internal
// selection reports `isCollapsed: true` at the document level, because both
// of its endpoints collapse onto the host. Nothing here may gate on
// `isCollapsed`, or on any other document-level view of a selection that
// lives inside the shadow root.
//
// caretPositionFromPoint with the `shadowRoots` option resolves correctly in
// Chrome, Playwright WebKit and the system WKWebView krit.app embeds alike,
// so there is one path here and no fork. It also asks the layout engine
// where a coordinate lands instead of inferring it, which is what makes tabs,
// ligatures, CJK, font fallback and wrapped lines someone else's problem.
// (WebKit's legacy `caretRangeFromPoint` does *not* pierce the boundary in
// any engine — it is not a usable fallback.)
//
// Caret resolution is "nearest insertion point", so two engines can disagree
// by one column when the pointer sits at the exact horizontal midpoint of a
// character — one rounds back, one forward. That is correct for a selection
// endpoint; nothing here may assume a rounding direction.
//
// Two further details of the rendered markup:
//
// - Each line's container carries `data-line="<lineNumber>"`, but its text is
//   split across nested syntax-highlighting `<span>`s, so a raw caret offset
//   is "offset within whichever span was hit," not a column. The true column
//   comes from the range-to-string-length trick: build a Range from the line
//   container's start to the caret point and take `.toString().length`.
// - `Range.toString()` has no concept of line boundaries and silently drops
//   line breaks, so `selectedText` is rebuilt from the range's cloned
//   per-line DOM structure instead (see reconstructSelectedText).

export interface SelectionAnchor {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  selectedText: string
}

// Viewport coordinates of one end of the drag (a mousedown or mouseup).
export interface DragPoint {
  x: number
  y: number
}

interface CaretPoint {
  node: Node
  offset: number
}

type CaretPositionFromPoint = (
  x: number,
  y: number,
  options?: { shadowRoots?: ShadowRoot[] },
) => { offsetNode: Node; offset: number } | null

// Resolves a viewport coordinate to a caret position inside `root`.
//
// The `shadowRoots` option is what makes the result shadow-internal; an
// engine that doesn't support it ignores it silently and hands back a
// position retargeted to the shadow host. That is indistinguishable from
// success except by checking containment, which is why the result is
// rejected unless it landed inside the root we asked about — degrading to
// "no anchor" rather than to a wrong one.
function caretPointFromCoords(point: DragPoint, root: ShadowRoot): CaretPoint | null {
  const fn = (document as Document & { caretPositionFromPoint?: CaretPositionFromPoint })
    .caretPositionFromPoint
  if (typeof fn !== 'function') return null
  let pos: { offsetNode: Node; offset: number } | null
  try {
    pos = fn.call(document, point.x, point.y, { shadowRoots: [root] })
  } catch {
    return null
  }
  if (!pos?.offsetNode) return null
  if (!root.contains(pos.offsetNode)) return null
  return { node: pos.offsetNode, offset: pos.offset }
}

// True if `b` precedes `a` in document order — i.e. the user dragged
// backwards, upward or right-to-left.
function isBackwards(a: CaretPoint, b: CaretPoint): boolean {
  if (a.node === b.node) return b.offset < a.offset
  const rel = a.node.compareDocumentPosition(b.node)
  return (rel & Node.DOCUMENT_POSITION_PRECEDING) !== 0
}

// The shadow root the drag happened inside, taken from the deep (untargeted)
// event target — `e.composedPath()[0]`. At a light-DOM listener `e.target`
// has already been retargeted to the host, whose root is the document, so
// only the composed path identifies the right root.
export function shadowRootOf(eventTarget: EventTarget | null): ShadowRoot | null {
  const node = eventTarget instanceof Node ? eventTarget : null
  const root = node?.getRootNode?.()
  return root instanceof ShadowRoot ? root : null
}

// Builds a forward Range spanning the drag, from the coordinates of its
// mousedown and mouseup. Returns null if either endpoint can't be resolved
// inside the shadow root, or if the drag was really a click (both endpoints
// resolve to the same caret) — a collapsed selection must produce no anchor
// and no pill.
export function rangeFromDragPoints(
  start: DragPoint,
  end: DragPoint,
  eventTarget: EventTarget | null,
): Range | null {
  const root = shadowRootOf(eventTarget)
  if (!root) return null
  const a = caretPointFromCoords(start, root)
  const b = caretPointFromCoords(end, root)
  if (!a || !b) return null
  const [from, to] = isBackwards(a, b) ? [b, a] : [a, b]
  try {
    const range = document.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    return range.collapsed ? null : range
  } catch {
    return null
  }
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
    // the caret landed outside any [data-line] container) — treat as
    // unmappable rather than guessing.
    return null
  }
}

// Range.toString() concatenates every text node's content in document
// order with nothing inserted at element boundaries — it has no concept of
// "these two chunks were on different lines," so a selection spanning a
// line break comes back with the line break silently dropped (in practice
// replaced by whatever incidental whitespace text node sits between the
// rendered line's DOM blocks, which is how this showed up as stray spaces
// instead of newlines). Reconstruct multi-line text properly by cloning
// the range's contents (which preserves the per-line [data-line]
// structure, including partial clones of the first/last lines) and
// joining each line block's own text with real '\n's.
function reconstructSelectedText(range: Range, fallback: string): string {
  let fragment: DocumentFragment
  try {
    fragment = range.cloneContents()
  } catch {
    return fallback
  }
  const lineBlocks = fragment.querySelectorAll('[data-line]')
  if (lineBlocks.length === 0) return fallback // single-line selection: no line boundary to reconstruct
  return Array.from(lineBlocks)
    .map((el) => el.textContent ?? '')
    .join('\n')
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

  const selectedText = reconstructSelectedText(range, range.toString())
  if (selectedText.length === 0) return null

  // rangeFromDragPoints already normalizes direction, but guard anyway — a
  // caller feeding in an arbitrary Range shouldn't be able to produce an
  // inverted anchor.
  if (startLine > endLine || (startLine === endLine && startColumn > endColumn)) {
    return { startLine: endLine, startColumn: endColumn, endLine: startLine, endColumn: startColumn, selectedText }
  }
  return { startLine, startColumn, endLine, endColumn, selectedText }
}
