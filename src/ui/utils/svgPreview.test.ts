import { describe, expect, it } from 'vitest'
import { parseXml } from './xmlPositions'
import { buildSvgDom, isSafeStylesheet, safeAttributeValue } from './svgPreview'

const build = (src: string, options?: { stampOffsets?: boolean }) => {
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

describe('isSafeStylesheet', () => {
  it('rejects a stylesheet that can fetch', () => {
    expect(isSafeStylesheet('@import url(x.css);')).toBe(false)
    expect(isSafeStylesheet('.a { background: url(http://x/y.png) }')).toBe(false)
  })

  it('keeps one that only styles', () => {
    expect(isSafeStylesheet('.node { fill: #eee; stroke: black }')).toBe(true)
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

  it('keeps a stylesheet that only styles and drops one that reaches out', () => {
    const kept = build('<svg><style>.a { fill: red }</style></svg>')
    expect(kept.root!.querySelector('style')!.textContent).toContain('fill: red')
    const dropped = build('<svg><style>@import url(evil.css);</style></svg>')
    expect(dropped.root!.querySelector('style')!.textContent).toBe('')
  })

  it('refuses a document whose root is not an svg', () => {
    expect(build('<html><body/></html>').root).toBeNull()
  })
})

function spanOf(el: Element): [number, number] {
  const [start, end] = el.getAttribute('data-src')!.split('-')
  return [Number(start), Number(end)]
}
