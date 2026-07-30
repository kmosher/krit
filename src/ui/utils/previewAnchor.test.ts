import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildLineIndex,
  domPointToSourceOffset,
  lineColToOffset,
  nearestSpanElement,
  offsetToLineCol,
  previewRangeToAnchor,
  readSpan,
  renderedOffsetOf,
  sourceOffsetToDomPoint,
  sourceRangeToDomRange,
} from './previewAnchor'

// These exercise the mapping, not the renderer: each test hand-builds the DOM
// react-markdown would produce for the given source, with the same `data-src`
// stamps rehypeSourceOffsets writes. MarkdownPreview.test.tsx checks that the
// real renderer produces stamps of this shape.

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

beforeEach(() => {
  document.body.innerHTML = ''
})

/** First text node whose value matches, depth-first. */
function textNode(root: Node, value: string): Text {
  const walk = (n: Node): Text | null => {
    if (n.nodeType === 3 && n.nodeValue === value) return n as Text
    for (let c = n.firstChild; c; c = c.nextSibling) {
      const hit = walk(c)
      if (hit) return hit
    }
    return null
  }
  const found = walk(root)
  if (!found) throw new Error(`no text node ${JSON.stringify(value)}`)
  return found
}

describe('buildLineIndex / offsetToLineCol', () => {
  it('maps offsets to 1-based lines and 0-based columns', () => {
    const source = 'alpha\nbravo\n\ncharlie'
    const idx = buildLineIndex(source)
    expect(idx).toEqual([0, 6, 12, 13])
    expect(offsetToLineCol(idx, 0)).toEqual({ line: 1, column: 0 })
    expect(offsetToLineCol(idx, 4)).toEqual({ line: 1, column: 4 })
    // The newline itself belongs to the line it terminates.
    expect(offsetToLineCol(idx, 5)).toEqual({ line: 1, column: 5 })
    expect(offsetToLineCol(idx, 6)).toEqual({ line: 2, column: 0 })
    expect(offsetToLineCol(idx, 13)).toEqual({ line: 4, column: 0 })
    expect(offsetToLineCol(idx, 19)).toEqual({ line: 4, column: 6 })
  })

  it('round-trips through lineColToOffset', () => {
    const source = 'one\ntwo\nthree'
    const idx = buildLineIndex(source)
    for (let off = 0; off <= source.length; off++) {
      const { line, column } = offsetToLineCol(idx, off)
      expect(lineColToOffset(idx, line, column)).toBe(off)
    }
  })
})

describe('readSpan / nearestSpanElement', () => {
  it('reads the stamp and rejects malformed ones', () => {
    const root = mount('<p data-src="4-9"></p><p data-src="oops"></p><p data-src="9-4"></p><p></p>')
    const [ok, malformed, inverted, bare] = Array.from(root.children)
    expect(readSpan(ok)).toEqual({ start: 4, end: 9 })
    expect(readSpan(malformed)).toBeNull()
    expect(readSpan(inverted)).toBeNull()
    expect(readSpan(bare)).toBeNull()
  })

  it('walks up past unstamped elements and stops at the root', () => {
    const root = mount('<p data-src="0-10"><span><b>x</b></span></p>')
    const b = root.querySelector('b')!
    expect(nearestSpanElement(b.firstChild, root)).toBe(root.querySelector('p'))
    const orphan = document.createElement('i')
    expect(nearestSpanElement(orphan, root)).toBeNull()
  })
})

describe('renderedOffsetOf', () => {
  it('counts text in document order, across nested elements', () => {
    const root = mount('<p data-src="0-1">Para with <strong>bold</strong> tail.</p>')
    const p = root.querySelector('p')!
    expect(renderedOffsetOf(p, textNode(p, 'Para with '))).toBe(0)
    expect(renderedOffsetOf(p, textNode(p, 'bold'))).toBe(10)
    expect(renderedOffsetOf(p, textNode(p, ' tail.'))).toBe(14)
  })
})

describe('domPointToSourceOffset', () => {
  it('is exact for text that survived rendering unchanged', () => {
    // Source: `# Title` at offsets 0-7. The heading's own `# ` is markup, so
    // the element span is two longer than its text.
    const source = '# Title'
    const root = mount('<h1 data-src="0-7">Title</h1>')
    const t = textNode(root, 'Title')
    expect(domPointToSourceOffset(t, 0, root, source, 'start')).toBe(2)
    expect(domPointToSourceOffset(t, 5, root, source, 'end')).toBe(7)
  })

  it('locates a run inside an element whose markup shifts it', () => {
    //          0123456789...
    const source = 'Para with **bold** tail.'
    const root = mount(
      '<p data-src="0-24">Para with <strong data-src="10-18">bold</strong> tail.</p>',
    )
    const before = textNode(root, 'Para with ')
    const bold = textNode(root, 'bold')
    const after = textNode(root, ' tail.')
    expect(domPointToSourceOffset(before, 0, root, source, 'start')).toBe(0)
    expect(domPointToSourceOffset(before, 5, root, source, 'start')).toBe(5)
    // `bold` sits two past its element's start, behind the `**`.
    expect(domPointToSourceOffset(bold, 0, root, source, 'start')).toBe(12)
    expect(domPointToSourceOffset(bold, 4, root, source, 'end')).toBe(16)
    expect(domPointToSourceOffset(after, 6, root, source, 'end')).toBe(24)
  })

  it('disambiguates a repeated run using its rendered position as a floor', () => {
    const source = 'go **go** go'
    const root = mount('<p data-src="0-12">go <strong data-src="3-9">go</strong> go</p>')
    const first = textNode(root, 'go ')
    const p = root.querySelector('p')!
    // The trailing ' go' must not match the leading 'go ' at offset 0.
    const last = p.lastChild as Text
    expect(domPointToSourceOffset(first, 0, root, source, 'start')).toBe(0)
    expect(domPointToSourceOffset(last, 0, root, source, 'start')).toBe(9)
  })

  it('snaps outward when escapes break the correspondence', () => {
    // Rendered `A *x* and & more` is shorter than its source and the loss is
    // in the middle, so no run can be located: the range must widen, never
    // land somewhere plausible-but-wrong.
    const source = 'A \\*x\\* and &amp; more'
    const root = mount(`<p data-src="0-${source.length}">A *x* and &amp; more</p>`)
    const t = textNode(root, 'A *x* and & more')
    expect(domPointToSourceOffset(t, 4, root, source, 'start')).toBe(0)
    expect(domPointToSourceOffset(t, 4, root, source, 'end')).toBe(source.length)
  })

  it('returns null outside anything the renderer stamped', () => {
    const root = mount('<p>unstamped</p>')
    const t = textNode(root, 'unstamped')
    expect(domPointToSourceOffset(t, 0, root, 'unstamped', 'start')).toBeNull()
  })

  it('resolves an element-anchored range endpoint to a character', () => {
    const source = '# Title'
    const root = mount('<h1 data-src="0-7">Title</h1>')
    const h1 = root.querySelector('h1')!
    // offset 0 of an element means "before its first child".
    expect(domPointToSourceOffset(h1, 0, root, source, 'start')).toBe(2)
    // offset === childNodes.length means "after the last child".
    expect(domPointToSourceOffset(h1, 1, root, source, 'end')).toBe(7)
  })
})

describe('previewRangeToAnchor', () => {
  const source = 'Intro line.\n\nPara with **bold** tail.\n'
  const html =
    '<p data-src="0-11">Intro line.</p>' +
    '<p data-src="13-37">Para with <strong data-src="23-31">bold</strong> tail.</p>'

  it('produces the same anchor shape a diff selection produces', () => {
    const root = mount(html)
    const bold = textNode(root, 'bold')
    const range = document.createRange()
    range.setStart(bold, 0)
    range.setEnd(bold, 4)
    const anchor = previewRangeToAnchor(range, root, source)
    expect(anchor).toEqual({
      startLine: 3,
      startColumn: 12,
      endLine: 3,
      endColumn: 16,
      selectedText: 'bold',
    })
    // The persisted columns really do point at the source text.
    const idx = buildLineIndex(source)
    expect(
      source.slice(
        lineColToOffset(idx, anchor!.startLine, anchor!.startColumn),
        lineColToOffset(idx, anchor!.endLine, anchor!.endColumn),
      ),
    ).toBe('bold')
  })

  it('spans blocks and lines for a selection crossing paragraphs', () => {
    const root = mount(html)
    const range = document.createRange()
    range.setStart(textNode(root, 'Intro line.'), 6)
    range.setEnd(textNode(root, 'Para with '), 4)
    const anchor = previewRangeToAnchor(range, root, source)!
    expect(anchor.startLine).toBe(1)
    expect(anchor.startColumn).toBe(6)
    expect(anchor.endLine).toBe(3)
    expect(anchor.endColumn).toBe(4)
  })

  it('rejects a collapsed or whitespace-only selection', () => {
    const root = mount(html)
    const t = textNode(root, 'Intro line.')
    const collapsed = document.createRange()
    collapsed.setStart(t, 3)
    collapsed.setEnd(t, 3)
    expect(previewRangeToAnchor(collapsed, root, source)).toBeNull()
  })

  it('keeps the rendered text as selectedText even when the range snaps wider', () => {
    const escaped = 'A \\*x\\* and more'
    const root = mount(`<p data-src="0-${escaped.length}">A *x* and more</p>`)
    const t = textNode(root, 'A *x* and more')
    const range = document.createRange()
    range.setStart(t, 2)
    range.setEnd(t, 5)
    const anchor = previewRangeToAnchor(range, root, escaped)!
    expect(anchor.selectedText).toBe('*x*')
    // Widened to the whole paragraph rather than guessing inside it.
    expect(anchor.startColumn).toBe(0)
    expect(anchor.endColumn).toBe(escaped.length)
  })
})

describe('sourceOffsetToDomPoint / sourceRangeToDomRange', () => {
  const source = 'Para with **bold** tail.'
  const html = '<p data-src="0-24">Para with <strong data-src="10-18">bold</strong> tail.</p>'

  it('finds the rendered position of a source offset', () => {
    const root = mount(html)
    const at = sourceOffsetToDomPoint(root, source, 12)
    expect(at?.node.nodeValue).toBe('bold')
    expect(at?.offset).toBe(0)
  })

  it('round-trips a range back to the text it came from', () => {
    const root = mount(html)
    const range = sourceRangeToDomRange(root, source, 12, 16)
    expect(range?.toString()).toBe('bold')
  })

  it('returns null for an offset outside the rendered content', () => {
    const root = mount(html)
    expect(sourceOffsetToDomPoint(root, source, 999)).toBeNull()
  })

  it('searches through unstamped wrappers', () => {
    // What the modal actually mounts: the scroll container and the renderer's
    // own body div sit between the search root and the first stamped element,
    // and neither carries a span. Stopping at the first unstamped child would
    // make every highlight silently fail to paint.
    const root = mount(`<div class="scroller"><div class="markdown-preview-body">${html}</div></div>`)
    expect(sourceRangeToDomRange(root, source, 12, 16)?.toString()).toBe('bold')
  })

  it('does not descend into a stamped sibling that cannot contain the offset', () => {
    const two = 'first\n\nsecond'
    const root = mount('<p data-src="0-5">first</p><p data-src="7-13">second</p>')
    expect(sourceOffsetToDomPoint(root, two, 8)?.node.nodeValue).toBe('second')
  })
})
