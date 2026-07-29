import { describe, it, expect, afterEach } from 'vitest'
import { mapRangeToAnchor, rangeFromDragPoints, shadowRootOf } from './selectionMapping'

// Mirrors the shape @pierre/diffs renders: one [data-line] block per line,
// each holding several <span>s because syntax highlighting splits the text.
// The span split is the whole reason column arithmetic is hard, so every
// fixture line here has one.
function renderLines(lines: string[][], opts: { shadow?: boolean } = {}): {
  container: HTMLElement | ShadowRoot
  lineEl: (n: number) => HTMLElement
  span: (line: number, index: number) => Text
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const container: HTMLElement | ShadowRoot = opts.shadow ? host.attachShadow({ mode: 'open' }) : host
  lines.forEach((spans, i) => {
    const block = document.createElement('div')
    block.setAttribute('data-line', String(i + 1))
    for (const text of spans) {
      const s = document.createElement('span')
      s.textContent = text
      block.appendChild(s)
    }
    container.appendChild(block)
  })
  const lineEl = (n: number) => container.querySelectorAll('[data-line]')[n - 1] as HTMLElement
  const span = (line: number, index: number) => lineEl(line).children[index].firstChild as Text
  return { container, lineEl, span }
}

function rangeBetween(start: Node, startOffset: number, end: Node, endOffset: number): Range {
  const r = document.createRange()
  r.setStart(start, startOffset)
  r.setEnd(end, endOffset)
  return r
}

afterEach(() => {
  document.body.innerHTML = ''
  document.getSelection()?.removeAllRanges()
})

describe('mapRangeToAnchor', () => {
  it('reports the column as the offset within the line, not within the span', () => {
    // The reviewer selected "ll" in "hello". A raw Range.startOffset would say
    // column 0 because the selection landed at the start of the second
    // highlight span; the anchor would then point at the wrong characters when
    // the comment is re-rendered.
    const { span } = renderLines([['he', 'llo world']])
    const anchor = mapRangeToAnchor(rangeBetween(span(1, 1), 0, span(1, 1), 2))
    expect(anchor).toEqual({
      startLine: 1,
      startColumn: 2,
      endLine: 1,
      endColumn: 4,
      selectedText: 'll',
    })
  })

  it('counts every preceding span, not just the immediate one', () => {
    // Three spans deep: a column that only measured the current span would be
    // short by the width of everything to its left.
    const { span } = renderLines([['abc', 'def', 'ghij']])
    const anchor = mapRangeToAnchor(rangeBetween(span(1, 2), 1, span(1, 2), 3))
    expect(anchor?.startColumn).toBe(7)
    expect(anchor?.endColumn).toBe(9)
    expect(anchor?.selectedText).toBe('hi')
  })

  it('anchors to the line number in data-line, not the DOM order of the block', () => {
    // Krit renders windows of a diff, so the first rendered block is rarely
    // line 1. Deriving the line from position in the list would anchor every
    // comment in a scrolled-in hunk to the wrong place.
    const { lineEl, span } = renderLines([['aaa'], ['bbb']])
    lineEl(1).setAttribute('data-line', '40')
    lineEl(2).setAttribute('data-line', '41')
    const anchor = mapRangeToAnchor(rangeBetween(span(1, 0), 1, span(2, 0), 2))
    expect(anchor?.startLine).toBe(40)
    expect(anchor?.endLine).toBe(41)
  })

  it('joins a multi-line selection with real newlines', () => {
    // Range.toString() drops the line break entirely, so a two-line quote used
    // to come back as "one linetwo line" in the comment body.
    const { span } = renderLines([['one ', 'line'], ['two ', 'line']])
    const anchor = mapRangeToAnchor(rangeBetween(span(1, 0), 0, span(2, 1), 4))
    expect(anchor?.selectedText).toBe('one line\ntwo line')
  })

  it('keeps whole intermediate lines in a three-line selection', () => {
    // The middle line is cloned in full while the first and last are partial —
    // the reconstruction has to handle both in one pass.
    const { span } = renderLines([['alpha'], ['beta'], ['gamma']])
    const anchor = mapRangeToAnchor(rangeBetween(span(1, 0), 2, span(3, 0), 3))
    expect(anchor?.selectedText).toBe('pha\nbeta\ngam')
    expect(anchor).toMatchObject({ startLine: 1, startColumn: 2, endLine: 3, endColumn: 3 })
  })

  it('preserves an empty line in the middle of a selection', () => {
    // A blank line between two quoted lines must survive as an empty string,
    // not collapse the quote into adjacent text.
    const { span } = renderLines([['a'], [''], ['c']])
    const anchor = mapRangeToAnchor(rangeBetween(span(1, 0), 0, span(3, 0), 1))
    expect(anchor?.selectedText).toBe('a\n\nc')
  })

  it('returns only the selected substring for a single-line selection', () => {
    // The multi-line reconstruction clones whole [data-line] blocks; if it also
    // ran for single-line selections the comment would quote the entire line
    // instead of the few words the reviewer highlighted.
    const { span } = renderLines([['abcdefgh']])
    expect(mapRangeToAnchor(rangeBetween(span(1, 0), 2, span(1, 0), 5))?.selectedText).toBe('cde')
  })

  it('returns null when an endpoint is outside any rendered line', () => {
    // Dragging past the end of the diff puts the focus node in surrounding
    // chrome. Better to drop the selection pill than anchor a comment to a
    // guessed line.
    const { span } = renderLines([['abc']])
    const stray = document.createElement('p')
    stray.textContent = 'not code'
    document.body.appendChild(stray)
    expect(mapRangeToAnchor(rangeBetween(span(1, 0), 0, stray.firstChild!, 3))).toBeNull()
    expect(mapRangeToAnchor(rangeBetween(stray.firstChild!, 0, span(1, 0), 3))).toBeNull()
  })

  it('returns null when data-line is not a number', () => {
    // Pierre marks some non-code rows (expanders, hunk headers) with a
    // data-line that is not a line number; Number() would make those NaN and
    // the anchor would serialize as null in JSON.
    const { lineEl, span } = renderLines([['abc']])
    lineEl(1).setAttribute('data-line', 'expander')
    expect(mapRangeToAnchor(rangeBetween(span(1, 0), 0, span(1, 0), 3))).toBeNull()
  })

  it('returns null for a collapsed range', () => {
    // A plain click is a zero-width selection; it must not open a comment.
    const { span } = renderLines([['abc']])
    expect(mapRangeToAnchor(rangeBetween(span(1, 0), 1, span(1, 0), 1))).toBeNull()
  })

  it('returns null when the selection covers only empty text', () => {
    // Selecting across a blank rendered line yields no characters to quote.
    const { lineEl } = renderLines([['']])
    expect(mapRangeToAnchor(rangeBetween(lineEl(1), 0, lineEl(1), 1))).toBeNull()
  })

  it('normalizes an inverted range instead of emitting a backwards anchor', () => {
    // Callers can hand in any Range. A start after the end would persist an
    // anchor the renderer cannot highlight.
    const { span } = renderLines([['abcdef']])
    // A real Range cannot be inverted — setStart past the end collapses it —
    // so the backwards endpoints have to be stood up on the prototype.
    const inverted = Object.create(Range.prototype) as Range
    Object.defineProperties(inverted, {
      startContainer: { value: span(1, 0) },
      startOffset: { value: 4 },
      endContainer: { value: span(1, 0) },
      endOffset: { value: 1 },
      cloneContents: { value: () => document.createDocumentFragment() },
      toString: { value: () => 'bcd' },
    })
    expect(mapRangeToAnchor(inverted)).toMatchObject({ startColumn: 1, endColumn: 4 })
  })

  it('normalizes an inverted multi-line range', () => {
    const { span } = renderLines([['abc'], ['def']])
    const inverted = Object.create(Range.prototype) as Range
    Object.defineProperties(inverted, {
      startContainer: { value: span(2, 0) },
      startOffset: { value: 2 },
      endContainer: { value: span(1, 0) },
      endOffset: { value: 1 },
      cloneContents: { value: () => document.createDocumentFragment() },
      toString: { value: () => 'bcde' },
    })
    expect(mapRangeToAnchor(inverted)).toMatchObject({
      startLine: 1,
      startColumn: 1,
      endLine: 2,
      endColumn: 2,
    })
  })

  it('maps a selection that ends at column 0 of the following line', () => {
    // This is what a browser produces when the reviewer drags just past the end
    // of a line — the anchor must stay on the next line at column 0 rather than
    // being clamped back, or the highlight and the quote disagree.
    const { span, lineEl } = renderLines([['abc'], ['def']])
    const anchor = mapRangeToAnchor(rangeBetween(span(1, 0), 1, lineEl(2), 0))
    expect(anchor).toMatchObject({ startLine: 1, startColumn: 1, endLine: 2, endColumn: 0 })
    expect(anchor?.selectedText).toBe('bc\n')
  })

  it('maps a selection made inside a shadow root', () => {
    // CodeView renders into an open shadow root; the [data-line] walk has to
    // work there, where document-level queries would find nothing.
    const { span } = renderLines([['sha', 'dow']], { shadow: true })
    expect(mapRangeToAnchor(rangeBetween(span(1, 1), 0, span(1, 1), 3))).toMatchObject({
      startColumn: 3,
      endColumn: 6,
      selectedText: 'dow',
    })
  })

  it('counts non-ASCII characters as UTF-16 code units, matching the editor', () => {
    // Columns are persisted and later replayed against the file text; using a
    // different unit here than the editor uses would shift the highlight.
    const { span } = renderLines([['café ', 'naïve']])
    const anchor = mapRangeToAnchor(rangeBetween(span(1, 1), 0, span(1, 1), 5))
    expect(anchor?.startColumn).toBe(5)
    expect(anchor?.endColumn).toBe(10)
  })
})


describe('shadowRootOf', () => {
  it('finds the shadow root of a shadow-internal node', () => {
    const { container, span } = renderLines([['abc']], { shadow: true })
    expect(shadowRootOf(span(1, 0))).toBe(container)
  })

  it('returns null for a light-DOM node or a non-Node target', () => {
    // A mouseup on light-DOM chrome, or an EventTarget with no getRootNode at
    // all, must not throw — it just means there is nothing to hit-test into.
    const { span } = renderLines([['abc']])
    expect(shadowRootOf(span(1, 0))).toBeNull()
    expect(shadowRootOf(new EventTarget())).toBeNull()
    expect(shadowRootOf(null)).toBeNull()
  })
})

// happy-dom implements no layout, so it has no caretPositionFromPoint. These
// stubs stand in for the browser's hit-testing: a coordinate is looked up in
// a fixture map, and — like a real engine — the shadow-internal answer is
// only given when the shadow root was passed in the options. The stubs prove
// our dispatch and normalization logic; they cannot prove any engine behaves
// this way (that was measured separately, in Chrome, Playwright WebKit and
// the system WKWebView).
describe('rangeFromDragPoints', () => {
  type Caret = { node: Node; offset: number }

  function stubCaret(
    points: Array<[number, number, Caret]>,
    opts: { pierces?: boolean; retargetTo?: Caret } = {},
  ) {
    const pierces = opts.pierces ?? true
    const calls: Array<{ x: number; y: number; roots: ShadowRoot[] | undefined }> = []
    const fn = (x: number, y: number, options?: { shadowRoots?: ShadowRoot[] }) => {
      calls.push({ x, y, roots: options?.shadowRoots })
      const hit = points.find(([px, py]) => px === x && py === y)
      if (!hit) return null
      const caret = hit[2]
      const root = caret.node.getRootNode()
      // An engine that ignores the option (or was not given one) answers
      // outside the shadow root — at the host, whose offsets are child
      // indices rather than characters. `retargetTo` lets a test aim that at
      // a position which is perfectly well-formed but simply not ours, so the
      // containment check is the only thing that can reject it.
      const asked = options?.shadowRoots?.includes(root as ShadowRoot) ?? false
      if (root instanceof ShadowRoot && !(pierces && asked)) {
        const away = opts.retargetTo
        return away
          ? { offsetNode: away.node, offset: away.offset + caret.offset }
          : { offsetNode: root.host, offset: 0 }
      }
      return { offsetNode: caret.node, offset: caret.offset }
    }
    Object.defineProperty(document, 'caretPositionFromPoint', {
      value: fn,
      configurable: true,
      writable: true,
    })
    return calls
  }

  afterEach(() => {
    delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint
  })

  it('builds a forward range from the two drag coordinates', () => {
    const { span } = renderLines([['abcdef']], { shadow: true })
    stubCaret([
      [10, 5, { node: span(1, 0), offset: 1 }],
      [40, 5, { node: span(1, 0), offset: 4 }],
    ])
    const range = rangeFromDragPoints({ x: 10, y: 5 }, { x: 40, y: 5 }, span(1, 0))
    expect(range?.toString()).toBe('bcd')
  })

  it('passes the shadow root so hit-testing pierces the boundary', () => {
    // Without the shadowRoots option every engine answers with the host, which
    // is exactly the bug this rewrite exists to avoid.
    const { container, span } = renderLines([['abcdef']], { shadow: true })
    const calls = stubCaret([
      [10, 5, { node: span(1, 0), offset: 1 }],
      [40, 5, { node: span(1, 0), offset: 4 }],
    ])
    rangeFromDragPoints({ x: 10, y: 5 }, { x: 40, y: 5 }, span(1, 0))
    expect(calls).toHaveLength(2)
    expect(calls[0].roots).toEqual([container])
    expect(calls[1].roots).toEqual([container])
  })

  it('normalizes a backwards drag within one line', () => {
    // Dragging right-to-left must anchor the same characters as left-to-right;
    // an inverted anchor cannot be highlighted when the comment is replayed.
    const { span } = renderLines([['abcdef']], { shadow: true })
    stubCaret([
      [40, 5, { node: span(1, 0), offset: 4 }],
      [10, 5, { node: span(1, 0), offset: 1 }],
    ])
    const range = rangeFromDragPoints({ x: 40, y: 5 }, { x: 10, y: 5 }, span(1, 0))
    expect(range?.toString()).toBe('bcd')
    expect(range?.startOffset).toBe(1)
  })

  it('normalizes a backwards drag spanning lines', () => {
    // Different nodes, so the ordering has to come from document position, not
    // from comparing offsets.
    const { span } = renderLines([['abc'], ['def']], { shadow: true })
    stubCaret([
      [30, 25, { node: span(2, 0), offset: 2 }],
      [10, 5, { node: span(1, 0), offset: 1 }],
    ])
    const range = rangeFromDragPoints({ x: 30, y: 25 }, { x: 10, y: 5 }, span(1, 0))
    expect(range?.startContainer).toBe(span(1, 0))
    expect(range?.startOffset).toBe(1)
    expect(range?.endContainer).toBe(span(2, 0))
    expect(range?.endOffset).toBe(2)
  })

  it('spans lines on a forward drag', () => {
    const { span } = renderLines([['abc'], ['def']], { shadow: true })
    stubCaret([
      [10, 5, { node: span(1, 0), offset: 1 }],
      [30, 25, { node: span(2, 0), offset: 2 }],
    ])
    const range = rangeFromDragPoints({ x: 10, y: 5 }, { x: 30, y: 25 }, span(1, 0))
    expect(mapRangeToAnchor(range!)).toMatchObject({
      startLine: 1,
      startColumn: 1,
      endLine: 2,
      endColumn: 2,
      selectedText: 'bc\nde',
    })
  })

  it('returns null for a click, where both endpoints resolve to the same caret', () => {
    // A click still fires mousedown and mouseup; it must not open a pill.
    const { span } = renderLines([['abcdef']], { shadow: true })
    stubCaret([
      [20, 5, { node: span(1, 0), offset: 2 }],
      [21, 5, { node: span(1, 0), offset: 2 }],
    ])
    expect(rangeFromDragPoints({ x: 20, y: 5 }, { x: 21, y: 5 }, span(1, 0))).toBeNull()
  })

  it('returns null when the engine ignores the shadowRoots option', () => {
    // The degradation that matters: an engine without the option answers
    // outside the shadow root. The answer is a valid, non-collapsed position
    // — it is simply about different text — so only checking that it landed
    // inside the root we asked about can tell it from a real hit.
    const { span } = renderLines([['abcdef']], { shadow: true })
    const light = document.createElement('p')
    light.textContent = 'outside the shadow root'
    document.body.appendChild(light)
    stubCaret(
      [
        [10, 5, { node: span(1, 0), offset: 1 }],
        [40, 5, { node: span(1, 0), offset: 4 }],
      ],
      { pierces: false, retargetTo: { node: light.firstChild!, offset: 0 } },
    )
    expect(rangeFromDragPoints({ x: 10, y: 5 }, { x: 40, y: 5 }, span(1, 0))).toBeNull()
  })

  it('returns null when caretPositionFromPoint is missing entirely', () => {
    // Older WebKit has only the legacy caretRangeFromPoint, which does not
    // pierce the shadow boundary in any engine. No pill beats a wrong anchor.
    const { span } = renderLines([['abcdef']], { shadow: true })
    delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint
    expect(rangeFromDragPoints({ x: 10, y: 5 }, { x: 40, y: 5 }, span(1, 0))).toBeNull()
  })

  it('returns null when an endpoint hits nothing', () => {
    // Releasing the mouse outside the window resolves to no caret at all.
    const { span } = renderLines([['abcdef']], { shadow: true })
    stubCaret([[10, 5, { node: span(1, 0), offset: 1 }]])
    expect(rangeFromDragPoints({ x: 10, y: 5 }, { x: 999, y: 999 }, span(1, 0))).toBeNull()
    expect(rangeFromDragPoints({ x: 999, y: 999 }, { x: 10, y: 5 }, span(1, 0))).toBeNull()
  })

  it('returns null when the drag did not start inside a shadow root', () => {
    // Light-DOM chrome around the diff: there is no code surface to anchor to.
    const { span } = renderLines([['abcdef']])
    stubCaret([
      [10, 5, { node: span(1, 0), offset: 1 }],
      [40, 5, { node: span(1, 0), offset: 4 }],
    ])
    expect(rangeFromDragPoints({ x: 10, y: 5 }, { x: 40, y: 5 }, span(1, 0))).toBeNull()
  })

  it('survives an engine that throws from caretPositionFromPoint', () => {
    // A throw here would take down the mouseup handler and freeze commenting.
    const { span } = renderLines([['abcdef']], { shadow: true })
    Object.defineProperty(document, 'caretPositionFromPoint', {
      value: () => {
        throw new Error('unsupported options argument')
      },
      configurable: true,
      writable: true,
    })
    expect(rangeFromDragPoints({ x: 10, y: 5 }, { x: 40, y: 5 }, span(1, 0))).toBeNull()
  })
})
