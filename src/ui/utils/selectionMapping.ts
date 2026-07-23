// Maps a native browser text selection made inside @pierre/diffs' rendered
// code surface to a (line, column) character anchor krit can persist.
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
// 3. Range.toString() has no concept of line boundaries either — for a
//    multi-line selection it silently drops the line break (see
//    reconstructSelectedText below), so the final selectedText is rebuilt
//    from the range's cloned per-line DOM structure instead of trusting
//    Range.toString() directly.

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

// Safari/WebKit path (incl. the Tauri desktop shell's WKWebView): no
// ShadowRoot.getSelection(), but the standard Selection.getComposedRanges()
// pierces the shadow boundary when handed the shadow root. Returns a live
// Range rebuilt from the first composed StaticRange, or null if the API is
// missing or the composed range still isn't shadow-internal.
//
// The API shipped with two signatures: the current spec takes an options
// object ({ shadowRoots }); original Safari 17 took variadic shadow roots.
// The wrong shape isn't an error — it just returns host-retargeted ranges —
// so try the spec form and fall back to variadic if the result didn't
// actually pierce into our root.
function getComposedSelectionRange(root: ShadowRoot): Range | null {
  const sel = document.getSelection() as
    | (Selection & {
        getComposedRanges?: (opts?: { shadowRoots?: ShadowRoot[] } | ShadowRoot) => StaticRange[]
      })
    | null
  if (!sel || typeof sel.getComposedRanges !== 'function') return null

  let ranges = sel.getComposedRanges({ shadowRoots: [root] })
  if (ranges.length === 0 || !root.contains(ranges[0].startContainer)) {
    ranges = sel.getComposedRanges(root)
  }
  const sr = ranges[0]
  if (!sr) return null
  if (sr.startContainer === sr.endContainer && sr.startOffset === sr.endOffset) return null
  try {
    const r = document.createRange()
    r.setStart(sr.startContainer, sr.startOffset)
    r.setEnd(sr.endContainer, sr.endOffset)
    return r
  } catch {
    return null
  }
}

// Returns the active selection's Range, using the shadow-aware lookup
// above, seeded from the node an originating event touched (its
// composedPath()[0] is the deepest — possibly shadow-internal — target,
// which is what tells us which shadow root to ask).
export function getActiveSelectionRange(eventTarget: EventTarget | null): Range | null {
  const node = eventTarget instanceof Node ? eventTarget : null
  const root = node?.getRootNode?.()
  const sel = getShadowAwareSelection(node)
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0)
    // document.getSelection() inside a shadow root hands back a range
    // retargeted to the host — detectable because it no longer sits inside
    // our shadow root. Fall through to getComposedRanges in that case
    // instead of returning a useless host-level range.
    if (!(root instanceof ShadowRoot) || root.contains(range.startContainer)) {
      return range
    }
  }
  if (root instanceof ShadowRoot) return getComposedSelectionRange(root)
  return null
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

  // Range should already be start-before-end (Selection.getRangeAt(0)
  // normalizes forward/backward drags), but guard anyway — a caller
  // feeding in an arbitrary Range shouldn't be able to produce an inverted
  // anchor.
  if (startLine > endLine || (startLine === endLine && startColumn > endColumn)) {
    return { startLine: endLine, startColumn: endColumn, endLine: startLine, endColumn: startColumn, selectedText }
  }
  return { startLine, startColumn, endLine, endColumn, selectedText }
}
