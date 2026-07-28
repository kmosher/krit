import { describe, it, expect, afterEach } from 'vitest'
import { getActiveSelectionRange, mapRangeToAnchor } from './selectionMapping'

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

describe('getActiveSelectionRange', () => {
  function selectInDocument(start: Node, startOffset: number, end: Node, endOffset: number): Range {
    const r = rangeBetween(start, startOffset, end, endOffset)
    const sel = document.getSelection()!
    sel.removeAllRanges()
    sel.addRange(r)
    return r
  }

  it('returns the live range for a light-DOM selection', () => {
    const { span } = renderLines([['abcdef']])
    selectInDocument(span(1, 0), 1, span(1, 0), 4)
    const range = getActiveSelectionRange(span(1, 0))
    expect(range?.toString()).toBe('bcd')
  })

  it('returns null when the selection is collapsed', () => {
    // Every click collapses the selection; returning a range here would make
    // the comment pill flicker on every click in the diff.
    const { span } = renderLines([['abcdef']])
    selectInDocument(span(1, 0), 2, span(1, 0), 2)
    expect(getActiveSelectionRange(span(1, 0))).toBeNull()
  })

  it('returns null when there is no selection at all', () => {
    const { span } = renderLines([['abcdef']])
    document.getSelection()!.removeAllRanges()
    expect(getActiveSelectionRange(span(1, 0))).toBeNull()
  })

  it('falls back to the document selection for a non-Node event target', () => {
    // The target only exists to name a shadow root; without one there is
    // nothing to retarget past, so the document selection stands. It must not
    // throw on a target that has no getRootNode.
    const { span } = renderLines([['abcdef']])
    selectInDocument(span(1, 0), 1, span(1, 0), 4)
    expect(getActiveSelectionRange(new EventTarget())?.toString()).toBe('bcd')
    expect(getActiveSelectionRange(null)?.toString()).toBe('bcd')
  })

  it('accepts a shadow-internal range from document.getSelection()', () => {
    // Some engines hand back the real shadow-internal nodes; when they do we
    // must use that range directly rather than falling through to the
    // composed-range path.
    const { span } = renderLines([['shadow text']], { shadow: true })
    selectInDocument(span(1, 0), 0, span(1, 0), 6)
    expect(getActiveSelectionRange(span(1, 0))?.toString()).toBe('shadow')
  })

  it('rejects a host-retargeted range for a shadow-internal target', () => {
    // The engines that retarget hand back a range pointing at the shadow HOST,
    // whose offsets are child indices, not characters. Mapping that would
    // anchor the comment to garbage, so it must be discarded.
    const { span } = renderLines([['shadow text']], { shadow: true })
    const light = document.createElement('p')
    light.textContent = 'outside the shadow root'
    document.body.appendChild(light)
    selectInDocument(light.firstChild!, 0, light.firstChild!, 7)
    // No getComposedRanges in happy-dom, so the fallback yields null — the
    // point of the assertion is that the light-DOM range is NOT returned.
    expect(getActiveSelectionRange(span(1, 0))).toBeNull()
  })

  // happy-dom implements neither ShadowRoot.getSelection() (Chrome-only) nor
  // Selection.getComposedRanges() (Safari), so the branches that consume them
  // are exercised with stubs shaped like the real APIs. The stubs cover our
  // dispatch logic only; they cannot prove the real engines behave this way.
  describe('with stubbed engine selection APIs', () => {
    type ComposedSelection = Omit<Selection, 'getComposedRanges'> & {
      getComposedRanges?: (arg?: unknown) => StaticRange[]
    }

    function fakeSelection(over: Partial<Selection> & Record<string, unknown>): Selection {
      return { isCollapsed: false, rangeCount: 0, ...over } as unknown as Selection
    }

    function composedSelection(): ComposedSelection {
      return document.getSelection()! as unknown as ComposedSelection
    }

    function staticRange(sc: Node, so: number, ec: Node, eo: number): StaticRange {
      return { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo, collapsed: sc === ec && so === eo }
    }

    // Puts the document selection in the light DOM while the event target is
    // shadow-internal — indistinguishable, to this code, from an engine that
    // retargeted a shadow selection to the host.
    function selectOutsideTheShadowRoot() {
      const light = document.createElement('p')
      light.textContent = 'outside'
      document.body.appendChild(light)
      selectInDocument(light.firstChild!, 0, light.firstChild!, 7)
    }

    it("prefers ShadowRoot.getSelection() over the document's retargeted one", () => {
      const { container, span } = renderLines([['shadow text']], { shadow: true })
      selectOutsideTheShadowRoot()
      const real = rangeBetween(span(1, 0), 0, span(1, 0), 6)
      Object.assign(container as ShadowRoot, {
        getSelection: () => fakeSelection({ rangeCount: 1, getRangeAt: () => real }),
      })
      expect(getActiveSelectionRange(span(1, 0))).toBe(real)
    })

    it('does not call getRangeAt on a selection with no ranges', () => {
      // Chrome's ShadowRoot.getSelection() can hand back a selection object
      // with rangeCount 0; getRangeAt(0) throws IndexSizeError there, which
      // would take down the mouseup handler and freeze commenting entirely.
      const { container, span } = renderLines([['shadow text']], { shadow: true })
      Object.assign(container as ShadowRoot, {
        getSelection: () =>
          fakeSelection({
            rangeCount: 0,
            getRangeAt: () => {
              throw new Error('IndexSizeError')
            },
          }),
      })
      expect(getActiveSelectionRange(span(1, 0))).toBeNull()
    })

    it('falls back to the document selection when ShadowRoot.getSelection() returns nothing', () => {
      const { container, span } = renderLines([['shadow text']], { shadow: true })
      Object.assign(container as ShadowRoot, { getSelection: () => null })
      selectInDocument(span(1, 0), 0, span(1, 0), 6)
      expect(getActiveSelectionRange(span(1, 0))?.toString()).toBe('shadow')
    })

    it('rebuilds a live range from getComposedRanges when the selection is retargeted', () => {
      // The Safari/WKWebView path, which is what the Tauri desktop shell runs.
      const { span } = renderLines([['shadow text']], { shadow: true })
      selectOutsideTheShadowRoot()
      const sel = composedSelection()
      sel.getComposedRanges = () => [staticRange(span(1, 0), 0, span(1, 0), 6)]
      try {
        expect(getActiveSelectionRange(span(1, 0))?.toString()).toBe('shadow')
      } finally {
        delete sel.getComposedRanges
      }
    })

    it('retries the variadic signature when the spec-shaped call does not pierce the shadow root', () => {
      // Safari 17 shipped getComposedRanges(...shadowRoots) before the spec
      // settled on an options object. Passing the wrong shape is not an error —
      // it silently returns host-retargeted ranges — so the only way to notice
      // is that the result is not inside our root.
      const { container, span } = renderLines([['shadow text']], { shadow: true })
      const host = (container as ShadowRoot).host
      selectOutsideTheShadowRoot()
      const sel = composedSelection()
      const calls: unknown[] = []
      sel.getComposedRanges = (arg?: unknown) => {
        calls.push(arg)
        if (arg && !(arg instanceof ShadowRoot)) return [staticRange(host, 0, host, 1)]
        return [staticRange(span(1, 0), 0, span(1, 0), 6)]
      }
      try {
        expect(getActiveSelectionRange(span(1, 0))?.toString()).toBe('shadow')
        expect(calls).toHaveLength(2)
        expect(calls[1]).toBe(container)
      } finally {
        delete sel.getComposedRanges
      }
    })

    it('returns null when the composed range is collapsed', () => {
      // A click inside the shadow root under Safari still produces a composed
      // range; it is just zero-width and must not open a comment.
      const { span } = renderLines([['shadow text']], { shadow: true })
      selectOutsideTheShadowRoot()
      const sel = composedSelection()
      sel.getComposedRanges = () => [staticRange(span(1, 0), 3, span(1, 0), 3)]
      try {
        expect(getActiveSelectionRange(span(1, 0))).toBeNull()
      } finally {
        delete sel.getComposedRanges
      }
    })

    it('returns null when getComposedRanges yields no ranges at all', () => {
      const { span } = renderLines([['shadow text']], { shadow: true })
      selectOutsideTheShadowRoot()
      const sel = composedSelection()
      sel.getComposedRanges = () => []
      try {
        expect(getActiveSelectionRange(span(1, 0))).toBeNull()
      } finally {
        delete sel.getComposedRanges
      }
    })
  })
})
