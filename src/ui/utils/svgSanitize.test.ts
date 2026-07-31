import { describe, expect, it } from 'vitest'
import { parseXml } from './xmlPositions'
import { buildSvgDom, safeAttributeValue, type BuildOptions } from './svgSanitize'

const build = (src: string, options?: BuildOptions) => {
  const tree = parseXml(src)
  if (!tree) throw new Error(`unparseable: ${src}`)
  return buildSvgDom(tree, document, options)
}

describe('safeAttributeValue', () => {
  it('drops every event handler', () => {
    expect(safeAttributeValue('onload', 'alert(1)')).toBeNull()
    expect(safeAttributeValue('onBegin', 'alert(1)')).toBeNull()
  })

  it('allows a reference only as a same-document fragment', () => {
    expect(safeAttributeValue('href', '#gradient')).toBe('#gradient')
    expect(safeAttributeValue('href', 'https://example.com/x.svg')).toBeNull()
    expect(safeAttributeValue('xlink:href', 'data:image/png;base64,aGk=')).toBeNull()
  })

  it('allows url() only when it points into this document', () => {
    expect(safeAttributeValue('fill', 'url(#grad)')).toBe('url(#grad)')
    expect(safeAttributeValue('fill', "url('#grad')")).toBe("url('#grad')")
    expect(safeAttributeValue('fill', 'url(https://example.com/x.png)')).toBeNull()
  })

  it('drops a scripting scheme wherever it appears', () => {
    expect(safeAttributeValue('fill', 'javascript:alert(1)')).toBeNull()
    expect(safeAttributeValue('style', 'background:VBScript:x')).toBeNull()
  })

  it('leaves ordinary presentation attributes alone', () => {
    expect(safeAttributeValue('stroke-width', '2')).toBe('2')
    expect(safeAttributeValue('transform', 'translate(4, 8)')).toBe('translate(4, 8)')
  })
})

describe('buildSvgDom', () => {
  it('builds real SVG elements, not HTML ones', () => {
    const { root } = build('<svg><rect width="4"/></svg>')
    expect(root!.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(root!.firstElementChild!.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(root!.firstElementChild!.getAttribute('width')).toBe('4')
  })

  it('drops elements that can run or fetch, and says which', () => {
    const { root, removed } = build(
      '<svg><script>alert(1)</script><foreignObject><b/></foreignObject><rect/></svg>',
    )
    expect(root!.querySelector('script')).toBeNull()
    expect(root!.querySelector('foreignObject')).toBeNull()
    expect(root!.querySelector('rect')).not.toBeNull()
    expect(removed.sort()).toEqual(['foreignObject', 'script'])
  })

  it('keeps an animation element but not its handler', () => {
    const { root } = build('<svg><rect><animate onbegin="alert(1)" dur="1s"/></rect></svg>')
    // `animate` is not on the allowlist, so this is really asserting that a
    // handler cannot ride in on an element that is.
    const rect = root!.querySelector('rect')!
    expect(rect.getAttribute('onbegin')).toBeNull()
  })

  it('stamps every rendering element with its own source offsets', () => {
    const src = '<svg><text x="1">hi</text></svg>'
    const { root } = build(src)
    const text = root!.querySelector('text')!
    expect(src.slice(...spanOf(text))).toBe('<text x="1">hi</text>')
  })

  it('leaves non-rendering elements unstamped, so nothing anchors into them', () => {
    const { root } = build('<svg><title>A chart</title><desc>Long</desc><rect/></svg>')
    expect(root!.querySelector('title')!.getAttribute('data-src')).toBeNull()
    expect(root!.querySelector('desc')!.getAttribute('data-src')).toBeNull()
    expect(root!.querySelector('rect')!.getAttribute('data-src')).not.toBeNull()
  })

  it('stamps nothing at all when the offsets describe generated markup', () => {
    const { root } = build('<svg><text>hi</text></svg>', { stampOffsets: false })
    expect(root!.getAttribute('data-src')).toBeNull()
    expect(root!.querySelector('text')!.getAttribute('data-src')).toBeNull()
  })

  it('refuses a document whose root is not an svg', () => {
    expect(build('<html><body/></html>').root).toBeNull()
  })

  it('renders a namespace-prefixed document instead of calling it malformed', () => {
    const { root } = build('<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:rect/></svg:svg>')
    expect(root).not.toBeNull()
    expect(root!.querySelector('rect')).not.toBeNull()
  })

  it('drops a stylesheet from a reviewed file, and says it did', () => {
    // CSS cannot be filtered by pattern and an inline <style> is not scoped to
    // the picture — see `allowStylesheets`.
    const { root, removed } = build('<svg><style>.a{fill:red}</style><rect/></svg>')
    expect(root!.querySelector('style')).toBeNull()
    expect(removed).toContain('style')
  })

  it('keeps the stylesheet a diagram engine generated', () => {
    const { root } = build('<svg><style>.a{fill:red}</style><rect/></svg>', {
      allowStylesheets: true,
    })
    expect(root!.querySelector('style')!.textContent).toContain('fill: red'.replace(' ', ''))
  })

  it('never lets the file supply its own data-src or data-changed', () => {
    // The anchoring contract is that the renderer owns the stamp. A file that
    // stamps itself could point a comment at a range nobody selected.
    const src = '<svg data-src="9999-9999"><title data-src="1-2">t</title><rect data-changed="true" data-src="7-7"/></svg>'
    for (const stampOffsets of [true, false]) {
      const { root } = build(src, { stampOffsets })
      expect(root!.querySelector('title')!.getAttribute('data-src')).toBeNull()
      const rect = root!.querySelector('rect')!
      expect(rect.getAttribute('data-changed')).toBeNull()
      if (stampOffsets) {
        // The renderer's own stamp, which slices back to the element itself —
        // not the `7-7` the file asked for.
        expect(src.slice(...spanOf(rect))).toBe('<rect data-changed="true" data-src="7-7"/>')
      } else {
        expect(rect.getAttribute('data-src')).toBeNull()
      }
    }
  })

  it('drops xml:base, which would re-point every fragment reference', () => {
    expect(safeAttributeValue('xml:base', 'https://evil.example/')).toBeNull()
    const { root } = build('<svg xml:base="https://evil.example/"><use href="#a"/></svg>')
    expect(root!.getAttribute('xml:base')).toBeNull()
  })

  it('gates a reference bound to a non-xlink prefix the same way', () => {
    expect(safeAttributeValue('xl:href', 'https://evil.example/x.svg')).toBeNull()
    expect(safeAttributeValue('XLINK:HREF', '#frag')).toBe('#frag')
  })
})

function spanOf(el: Element): [number, number] {
  const [start, end] = el.getAttribute('data-src')!.split('-')
  return [Number(start), Number(end)]
}

describe('nesting depth', () => {
  const nested = (n: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(n)}<rect/>${'</g>'.repeat(n)}</svg>`

  // Recursion, here and in SvgPreview's markChanged pass over the result. Left
  // unbounded this throws RangeError from inside an effect, which React answers
  // by unmounting the whole root — the review, not the picture.
  it('cuts nesting past the cap instead of exhausting the stack', () => {
    const built = build(nested(20_000))
    expect(built.truncated).toBe(true)
    expect(built.root).not.toBeNull()
    // What survived is walkable: the markChanged pass recurses over exactly
    // this tree, so a cap the DOM outgrows would only move the crash.
    expect(built.root!.querySelectorAll('g').length).toBeLessThan(20_000)
  })

  it('leaves an ordinary picture alone', () => {
    const built = build(nested(20))
    expect(built.truncated).toBe(false)
    expect(built.root!.querySelectorAll('g').length).toBe(20)
    expect(built.root!.querySelector('rect')).not.toBeNull()
  })
})
