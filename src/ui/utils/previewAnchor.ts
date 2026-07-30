// Maps a selection over *rendered* document output (Markdown preview, HTML
// artifact) back to a character range in the file's source, so a comment made
// on a preview lands in the same schema-v3 anchor a comment made on the diff
// does. See docs/design/rendered-preview.md.
//
// The renderer's only obligation is to stamp `data-src="<start>-<end>"` on
// every element it emits, holding that element's source character offsets
// (see `rehypeSourceOffsets`). Everything here works off that one attribute,
// which is why the same code serves Markdown and parsed HTML.
//
// Why this is not simply "read the offset off the element":
//
// - An element's source span includes its own markup. `<strong>` spanning
//   `**bold**` is 8 source characters rendering 4, so an offset *inside* the
//   element does not map linearly onto its span.
// - Escapes and entities break the correspondence even with no element in
//   sight: the source `A \*x\* and &amp; more` renders as `A *x* and & more`,
//   shorter, with the loss distributed across the middle.
//
// So a rendered position is located rather than computed: find where this text
// node's exact value sits inside its element's source slice. That succeeds
// whenever the text survived the render unchanged (the overwhelmingly common
// case, including all of the `**bold**` family, because the *text* either side
// of the delimiters is untouched) and fails cleanly when it did not, at which
// point the range snaps outward to the enclosing element. An outward snap
// yields a source range that is a superset of what was highlighted, which is
// always safe to act on; `selectedText` carries what the reader actually
// selected either way.

import type { SelectionAnchor } from './selectionMapping'

export interface SourceSpan {
  start: number
  end: number
}

/**
 * Offsets at which each line of `source` begins. `lineStarts[0]` is always 0,
 * so a 1-based line number `n` indexes at `n - 1`.
 */
export function buildLineIndex(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/** 1-based line, 0-based column — the coordinates schema v3 persists. */
export function offsetToLineCol(
  lineStarts: number[],
  offset: number,
): { line: number; column: number } {
  // Binary search for the last line start at or before `offset`.
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: offset - lineStarts[lo] }
}

export function lineColToOffset(lineStarts: number[], line: number, column: number): number {
  const base = lineStarts[Math.min(Math.max(line, 1), lineStarts.length) - 1]
  return base + column
}

/** Reads the `data-src` stamp off one element. */
export function readSpan(el: Element): SourceSpan | null {
  const raw = el.getAttribute('data-src')
  if (!raw) return null
  const dash = raw.indexOf('-')
  if (dash <= 0) return null
  const start = Number(raw.slice(0, dash))
  const end = Number(raw.slice(dash + 1))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return { start, end }
}

/** Nearest element at or above `node` carrying a usable `data-src`, within `root`. */
export function nearestSpanElement(node: Node | null, root: Element): Element | null {
  let cur: Node | null = node
  while (cur && cur !== root.parentNode) {
    if (cur.nodeType === 1) {
      const el = cur as Element
      if (readSpan(el)) return el
    }
    cur = cur.parentNode
  }
  return null
}

/**
 * How many rendered characters inside `el` precede `target`. Counts text in
 * document order, which is the order `textContent` concatenates in.
 */
export function renderedOffsetOf(el: Element, target: Node): number {
  let count = 0
  let found = false
  const walk = (node: Node) => {
    if (found) return
    if (node === target) {
      found = true
      return
    }
    if (node.nodeType === 3) {
      count += (node.nodeValue ?? '').length
      return
    }
    for (let c = node.firstChild; c; c = c.nextSibling) {
      walk(c)
      if (found) return
    }
  }
  for (let c = el.firstChild; c; c = c.nextSibling) {
    walk(c)
    if (found) break
  }
  return count
}

/**
 * A DOM position (text node + offset) as a source offset.
 *
 * `side` decides which way an unlocatable position snaps: a range's start
 * snaps back to the enclosing element's start and its end snaps forward to
 * that element's end, so the result always contains the real selection.
 * Returns null only when the position is outside anything the renderer
 * stamped.
 */
export function domPointToSourceOffset(
  node: Node,
  offset: number,
  root: Element,
  source: string,
  side: 'start' | 'end',
): number | null {
  // Range endpoints in an element land on a child index, not a character.
  // Resolve to the adjacent text node so there is a value to locate.
  let target = node
  let charOffset = offset
  if (target.nodeType === 1) {
    const el = target as Element
    const child = el.childNodes[Math.min(offset, el.childNodes.length - 1)]
    if (child) {
      target = child
      charOffset = offset >= el.childNodes.length ? nodeTextLength(child) : 0
    }
  }

  const el = nearestSpanElement(target, root)
  if (!el) return null
  const span = readSpan(el)!

  if (target.nodeType === 3) {
    const value = target.nodeValue ?? ''
    const src = source.slice(span.start, span.end)
    if (value.length > 0) {
      // The source position of a rendered run is never earlier than its
      // rendered position — markup only ever adds characters — so the rendered
      // prefix length is a sound lower bound, and using it as the search floor
      // also disambiguates a run that repeats within the element.
      const floor = renderedOffsetOf(el, target)
      const idx = src.indexOf(value, Math.min(floor, Math.max(0, src.length - 1)))
      if (idx >= 0) {
        const at = span.start + idx + Math.min(charOffset, value.length)
        return Math.min(at, span.end)
      }
    }
  }

  return side === 'start' ? span.start : span.end
}

function nodeTextLength(node: Node): number {
  return node.nodeType === 3 ? (node.nodeValue ?? '').length : (node.textContent ?? '').length
}

/**
 * A selection over rendered output as the same anchor a diff selection
 * produces. `selectedText` is the *rendered* text — what the reader actually
 * highlighted — while the line/column range describes the source it came
 * from, so the two can legitimately disagree in length after an outward snap.
 *
 * Returns null for a collapsed selection, or one that lands entirely outside
 * the rendered content.
 */
export function previewRangeToAnchor(
  range: Range,
  root: Element,
  source: string,
  lineStarts: number[] = buildLineIndex(source),
): SelectionAnchor | null {
  const selectedText = range.toString()
  if (!selectedText.trim()) return null

  const startOffset = domPointToSourceOffset(
    range.startContainer,
    range.startOffset,
    root,
    source,
    'start',
  )
  const endOffset = domPointToSourceOffset(range.endContainer, range.endOffset, root, source, 'end')
  if (startOffset == null || endOffset == null) return null

  const lo = Math.max(0, Math.min(startOffset, endOffset))
  const hi = Math.min(source.length, Math.max(startOffset, endOffset))
  if (hi <= lo) return null

  const start = offsetToLineCol(lineStarts, lo)
  const end = offsetToLineCol(lineStarts, hi)
  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
    selectedText,
  }
}

/**
 * Reverse of `domPointToSourceOffset`: the DOM position showing a given source
 * offset, for painting an existing comment's highlight over the preview.
 * Returns null when the offset falls in source that produced no rendered
 * output (front matter, a link reference definition, markup between blocks).
 */
export function sourceOffsetToDomPoint(
  root: Element,
  source: string,
  offset: number,
): { node: Node; offset: number } | null {
  const el = innermostSpanAt(root, offset)
  if (!el) return null
  const span = readSpan(el)!
  const src = source.slice(span.start, span.end)
  const wanted = offset - span.start

  // Find the text node whose located source range covers `wanted`, using the
  // same locate-by-value rule the forward direction uses so the two agree.
  let fallback: { node: Node; offset: number } | null = null
  const texts: Text[] = []
  const collect = (node: Node) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) texts.push(c as Text)
      else if (c.nodeType === 1) collect(c)
    }
  }
  collect(el)

  for (const t of texts) {
    const value = t.nodeValue ?? ''
    if (!value.length) continue
    if (!fallback) fallback = { node: t, offset: 0 }
    const floor = renderedOffsetOf(el, t)
    const idx = src.indexOf(value, Math.min(floor, Math.max(0, src.length - 1)))
    if (idx < 0) continue
    if (wanted >= idx && wanted <= idx + value.length) {
      return { node: t, offset: wanted - idx }
    }
  }
  return fallback
}

/**
 * Innermost stamped element whose span contains `offset`.
 *
 * Recurses through *unstamped* elements rather than stopping at them: the
 * rendered tree is wrapped in layout containers the renderer never stamped
 * (`.markdown-preview-body` and the modal's scroller), and treating an
 * unstamped child as a dead end makes every lookup fail before it starts.
 */
function innermostSpanAt(root: Element, offset: number): Element | null {
  let found: Element | null = null
  const visit = (node: Element) => {
    for (const child of Array.from(node.children)) {
      const span = readSpan(child)
      if (span) {
        // A stamped sibling that doesn't contain the offset cannot have a
        // descendant that does — spans nest.
        if (offset < span.start || offset >= span.end) continue
        found = child
        visit(child)
        return
      }
      visit(child)
      if (found) return
    }
  }
  const rootSpan = readSpan(root)
  if (rootSpan && offset >= rootSpan.start && offset < rootSpan.end) found = root
  visit(root)
  return found
}

/** A DOM Range covering a source character range, for highlight painting. */
export function sourceRangeToDomRange(
  root: Element,
  source: string,
  startOffset: number,
  endOffset: number,
  doc: Document = root.ownerDocument ?? document,
): Range | null {
  const from = sourceOffsetToDomPoint(root, source, startOffset)
  // `endOffset` is exclusive, so step back into the last character's node.
  const to = sourceOffsetToDomPoint(root, source, Math.max(startOffset, endOffset - 1))
  if (!from || !to) return null
  const range = doc.createRange()
  try {
    range.setStart(from.node, Math.min(from.offset, nodeTextLength(from.node)))
    const endAt = sourceOffsetToDomPoint(root, source, endOffset)
    if (endAt && endAt.node === to.node) {
      range.setEnd(endAt.node, Math.min(endAt.offset, nodeTextLength(endAt.node)))
    } else {
      range.setEnd(to.node, nodeTextLength(to.node))
    }
  } catch {
    return null
  }
  return range.collapsed ? null : range
}
