import { describe, it, expect, afterEach } from 'vitest'
import {
  filePathForRoot,
  mapRangeToAnchor,
  rangeFromClick,
  rangeFromDragPoints,
  shadowRootOf,
} from './selectionMapping'

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

describe('filePathForRoot', () => {
  // A mounted file: one host element with its own shadow root, as CodeView
  // renders it, paired with the {id, element} entry getRenderedItems() reports.
  function mountFile(id: string): { root: ShadowRoot; rendered: { id: string; element: HTMLElement } } {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return { root: host.attachShadow({ mode: 'open' }), rendered: { id, element: host } }
  }

  it('resolves the file from the host of the root the drag happened in', () => {
    const a = mountFile('src/anchor.ts')
    expect(filePathForRoot(a.root, [a.rendered])).toBe('src/anchor.ts')
  })

  it('does not answer with a neighbouring file', () => {
    // Two files are mounted; each root must report its own. Getting this wrong
    // is the whole failure being fixed — the columns are right and the file is
    // someone else's, which no reviewer would think to check.
    const a = mountFile('src/anchor.ts')
    const b = mountFile('main.go')
    const rendered = [a.rendered, b.rendered]
    expect(filePathForRoot(a.root, rendered)).toBe('src/anchor.ts')
    expect(filePathForRoot(b.root, rendered)).toBe('main.go')
  })

  it('matches on element identity, not on position in the list', () => {
    // Hosts are pooled and reused, so the rendered list is not in any order the
    // caller can rely on; an index-based match would drift the moment CodeView
    // recycled or reordered an element.
    const a = mountFile('src/anchor.ts')
    const b = mountFile('main.go')
    expect(filePathForRoot(a.root, [b.rendered, a.rendered])).toBe('src/anchor.ts')
  })

  it('returns null for a host CodeView is not currently rendering', () => {
    // A root whose host has been released back to the pool must read as
    // "unknown" so the caller falls back, rather than as some other file.
    const orphan = mountFile('src/gone.ts')
    const live = mountFile('main.go')
    expect(filePathForRoot(orphan.root, [live.rendered])).toBeNull()
  })

  it('returns null for no root and for no rendered list', () => {
    const a = mountFile('src/anchor.ts')
    expect(filePathForRoot(null, [a.rendered])).toBeNull()
    expect(filePathForRoot(a.root, null)).toBeNull()
    expect(filePathForRoot(a.root, [])).toBeNull()
  })

  it('ignores entries with no element of their own', () => {
    // A known item that is not currently mounted has no element; treating a
    // missing element as a match would name a file at random.
    const a = mountFile('src/anchor.ts')
    expect(filePathForRoot(a.root, [{ id: 'unmounted.ts' }, a.rendered])).toBe('src/anchor.ts')
    expect(filePathForRoot(a.root, [{ id: 'unmounted.ts' }])).toBeNull()
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

  it('clamps rather than discards when an endpoint hits nothing', () => {
    // Releasing outside the text resolves to no caret at all. The reviewer can
    // still see what they highlighted, so the selection is clamped to the line
    // instead of thrown away — see the "endpoints off the text" block below,
    // which covers which end it clamps to. Here the point is only that a miss
    // no longer voids the whole drag.
    const { container, span } = renderLines([['abcdef']], { shadow: true })
    container.querySelectorAll('[data-line]').forEach((el) => {
      ;(el as HTMLElement).getBoundingClientRect = () =>
        ({ top: 0, bottom: 10, left: 100, right: 200, x: 100, y: 0, width: 100, height: 10 }) as DOMRect
    })
    stubCaret([[10, 5, { node: span(1, 0), offset: 1 }]])
    expect(rangeFromDragPoints({ x: 10, y: 5 }, { x: 999, y: 999 }, span(1, 0))?.toString()).toBe('bcdef')
    expect(rangeFromDragPoints({ x: 999, y: 999 }, { x: 10, y: 5 }, span(1, 0))?.toString()).toBe('bcdef')
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

// Points that miss the text entirely — the gutter, the padding past
// end-of-line, the gap below the last line. Hit-testing declines to answer for
// these, and discarding the whole drag because of one of them throws away a
// selection the reviewer can see highlighted.
describe('rangeFromDragPoints — endpoints off the text', () => {
  function layOut(container: HTMLElement | ShadowRoot, rects: Array<[number, number]>) {
    // happy-dom reports every rect as zero, so the geometry clamping reads has
    // to be supplied. Each line is given a band of y, spanning x 100..200.
    container.querySelectorAll('[data-line]').forEach((el, i) => {
      const [top, bottom] = rects[i]
      ;(el as HTMLElement).getBoundingClientRect = () =>
        ({ top, bottom, left: 100, right: 200, x: 100, y: top, width: 100, height: bottom - top }) as DOMRect
    })
  }

  function stubMiss(container: ShadowRoot, hits: Array<[number, number, { node: Node; offset: number }]>) {
    Object.defineProperty(document, 'caretPositionFromPoint', {
      value: (x: number, y: number, options?: { shadowRoots?: ShadowRoot[] }) => {
        const hit = hits.find(([px, py]) => px === x && py === y)
        if (!hit) return null // off the text: the engine has nothing to report
        if (!options?.shadowRoots?.length) return { offsetNode: container.host, offset: 0 }
        return { offsetNode: hit[2].node, offset: hit[2].offset }
      },
      configurable: true,
      writable: true,
    })
  }

  afterEach(() => {
    delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint
  })

  it('clamps an endpoint past end-of-line to the end of that line', () => {
    const { container, span } = renderLines([['abcdef']], { shadow: true })
    layOut(container, [[0, 10]])
    stubMiss(container as ShadowRoot, [[110, 5, { node: span(1, 0), offset: 1 }]])
    // Released at x=500, far right of the line's 100..200 box.
    const range = rangeFromDragPoints({ x: 110, y: 5 }, { x: 500, y: 5 }, span(1, 0))
    expect(range?.toString()).toBe('bcdef')
  })

  it('clamps an endpoint left of the text to the start of that line', () => {
    const { container, span } = renderLines([['abcdef']], { shadow: true })
    layOut(container, [[0, 10]])
    stubMiss(container as ShadowRoot, [[150, 5, { node: span(1, 0), offset: 3 }]])
    // Started in the gutter at x=20 and dragged right into the text.
    const range = rangeFromDragPoints({ x: 20, y: 5 }, { x: 150, y: 5 }, span(1, 0))
    expect(range?.toString()).toBe('abc')
  })

  it('clamps a point below every line to the end of the last one', () => {
    const { container, span } = renderLines([['abc'], ['def']], { shadow: true })
    layOut(container, [
      [0, 10],
      [10, 20],
    ])
    stubMiss(container as ShadowRoot, [[110, 5, { node: span(1, 0), offset: 0 }]])
    // Released at y=900, below everything — a drag off the bottom of the file.
    const range = rangeFromDragPoints({ x: 110, y: 5 }, { x: 150, y: 900 }, span(1, 0))
    expect(range?.toString()).toBe('abcdef')
  })

  it('still gives up when there is no line to clamp to', () => {
    const { container } = renderLines([], { shadow: true })
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    stubMiss(container as ShadowRoot, [])
    expect(rangeFromDragPoints({ x: 5, y: 5 }, { x: 9, y: 9 }, root)).toBeNull()
  })
})

// krit renders one diffs-container — and so one shadow root — per file.
describe('rangeFromDragPoints — across two files', () => {
  afterEach(() => {
    delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint
  })

  it('refuses a drag that starts in one file and ends in another', () => {
    const fileA = renderLines([['aaaaaa']], { shadow: true })
    const fileB = renderLines([['bbbbbb']], { shadow: true })
    Object.defineProperty(document, 'caretPositionFromPoint', {
      value: (x: number, _y: number, options?: { shadowRoots?: ShadowRoot[] }) => {
        const caret = x === 10 ? fileA.span(1, 0) : fileB.span(1, 0)
        const root = caret.getRootNode() as ShadowRoot
        if (!options?.shadowRoots?.includes(root)) return { offsetNode: root.host, offset: 0 }
        return { offsetNode: caret, offset: 2 }
      },
      configurable: true,
      writable: true,
    })
    // mousedown landed in file A, mouseup in file B. An anchor spanning two
    // files has nowhere to be stored — a comment belongs to one file.
    const range = rangeFromDragPoints(
      { x: 10, y: 5, target: fileA.span(1, 0) },
      { x: 90, y: 5 },
      fileB.span(1, 0),
    )
    expect(range).toBeNull()
  })

  it('allows a drag whose two ends are in the same file', () => {
    const { span } = renderLines([['abcdef']], { shadow: true })
    Object.defineProperty(document, 'caretPositionFromPoint', {
      value: (x: number) => ({ offsetNode: span(1, 0), offset: x === 10 ? 1 : 4 }),
      configurable: true,
      writable: true,
    })
    const range = rangeFromDragPoints(
      { x: 10, y: 5, target: span(1, 0) },
      { x: 40, y: 5 },
      span(1, 0),
    )
    expect(range?.toString()).toBe('bcd')
  })
})

// A double-click selects without moving the pointer, so the drag path sees a
// collapsed range and declines — but the reviewer is looking at a highlighted
// word and expects to comment on it.
describe('rangeFromClick', () => {
  function stubAt(caret: { node: Node; offset: number }) {
    Object.defineProperty(document, 'caretPositionFromPoint', {
      value: (_x: number, _y: number, options?: { shadowRoots?: ShadowRoot[] }) => {
        const root = caret.node.getRootNode()
        if (root instanceof ShadowRoot && !options?.shadowRoots?.includes(root)) {
          return { offsetNode: root.host, offset: 0 }
        }
        return { offsetNode: caret.node, offset: caret.offset }
      },
      configurable: true,
      writable: true,
    })
  }

  afterEach(() => {
    delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint
  })

  it('selects the whole word under a double-click', () => {
    const { span } = renderLines([['const ', 'parseAnchor', ' = 1']], { shadow: true })
    stubAt({ node: span(1, 1), offset: 4 }) // inside "parseAnchor"
    const range = rangeFromClick({ x: 10, y: 5 }, span(1, 1), 2)
    expect(range?.toString()).toBe('parseAnchor')
  })

  it('expands across the spans syntax highlighting split the word into', () => {
    // The whole reason this can't just read one text node: a highlighter is
    // free to break an identifier across spans, and the word is still a word.
    const { span } = renderLines([['parse', 'Anchor', '(']], { shadow: true })
    stubAt({ node: span(1, 0), offset: 2 })
    const range = rangeFromClick({ x: 10, y: 5 }, span(1, 0), 2)
    expect(range?.toString()).toBe('parseAnchor')
  })

  it('treats _ and $ as part of the word', () => {
    const { span } = renderLines([['let ', '$_private1', ';']], { shadow: true })
    stubAt({ node: span(1, 1), offset: 3 })
    expect(rangeFromClick({ x: 10, y: 5 }, span(1, 1), 2)?.toString()).toBe('$_private1')
  })

  it('stops at a non-word character', () => {
    const { span } = renderLines([['a.', 'bcd', '.e']], { shadow: true })
    stubAt({ node: span(1, 1), offset: 1 })
    expect(rangeFromClick({ x: 10, y: 5 }, span(1, 1), 2)?.toString()).toBe('bcd')
  })

  it('selects the whole line on a triple-click', () => {
    const { span } = renderLines([['const ', 'x', ' = 1']], { shadow: true })
    stubAt({ node: span(1, 1), offset: 0 })
    expect(rangeFromClick({ x: 10, y: 5 }, span(1, 1), 3)?.toString()).toBe('const x = 1')
  })

  it('does nothing for a single click', () => {
    // A plain click must leave the surface alone: it is how the reviewer
    // dismisses the pill and how gutter interactions start.
    const { span } = renderLines([['abcdef']], { shadow: true })
    stubAt({ node: span(1, 0), offset: 2 })
    expect(rangeFromClick({ x: 10, y: 5 }, span(1, 0), 1)).toBeNull()
  })

  it('returns null on an empty line', () => {
    const { container } = renderLines([[]], { shadow: true })
    const line = (container as ShadowRoot).querySelector('[data-line]') as HTMLElement
    stubAt({ node: line, offset: 0 })
    expect(rangeFromClick({ x: 10, y: 5 }, line, 2)).toBeNull()
  })

  it('passes the shadow root so hit-testing pierces the boundary', () => {
    const { span } = renderLines([['abcdef']], { shadow: true })
    let asked: ShadowRoot[] | undefined
    Object.defineProperty(document, 'caretPositionFromPoint', {
      value: (_x: number, _y: number, options?: { shadowRoots?: ShadowRoot[] }) => {
        asked = options?.shadowRoots
        return { offsetNode: span(1, 0), offset: 2 }
      },
      configurable: true,
      writable: true,
    })
    rangeFromClick({ x: 10, y: 5 }, span(1, 0), 2)
    expect(asked).toEqual([span(1, 0).getRootNode()])
  })
})
