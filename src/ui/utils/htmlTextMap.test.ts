import { describe, it, expect } from 'vitest'
import { buildHtmlTextMap, locateSelection } from './htmlTextMap'

/** Every emitted character must point at source that could have produced it. */
function assertOffsetsMonotonic(source: string, map: ReturnType<typeof buildHtmlTextMap>) {
  for (let i = 1; i < map.offsets.length; i++) {
    expect(map.offsets[i]).toBeGreaterThanOrEqual(map.offsets[i - 1])
  }
  for (const off of map.offsets) {
    expect(off).toBeGreaterThanOrEqual(0)
    expect(off).toBeLessThan(source.length)
  }
}

describe('buildHtmlTextMap', () => {
  it('emits visible text with the source offset of each character', () => {
    const source = '<p>Hello</p>'
    const map = buildHtmlTextMap(source)
    expect(map.text).toBe('Hello')
    expect(map.offsets).toEqual([3, 4, 5, 6, 7])
    expect(source[map.offsets[0]]).toBe('H')
  })

  it('drops tags, comments, and attribute values that contain angle brackets', () => {
    const source = '<!-- note --><div title="a > b" data-x=\'<y>\'>text</div>'
    const map = buildHtmlTextMap(source)
    expect(map.text).toBe('text')
    expect(source.slice(map.offsets[0], map.offsets[0] + 4)).toBe('text')
    assertOffsetsMonotonic(source, map)
  })

  it('skips script and style bodies, which render nothing', () => {
    const source = '<style>p{color:red}</style><p>shown</p><script>var x = "hidden"</script>'
    expect(buildHtmlTextMap(source).text).toBe('shown')
  })

  it('decodes entities and points every decoded character at the entity', () => {
    const source = '<p>a &amp; b &#65; &#x42;</p>'
    const map = buildHtmlTextMap(source)
    expect(map.text).toBe('a & b A B')
    // The '&' came from the five-character `&amp;`, so its offset is that of
    // the ampersand that opened it.
    const ampAt = map.text.indexOf('&')
    expect(source.slice(map.offsets[ampAt], map.offsets[ampAt] + 5)).toBe('&amp;')
    assertOffsetsMonotonic(source, map)
  })

  it('treats a bare angle bracket as literal text', () => {
    expect(buildHtmlTextMap('<p>3 < 4</p>').text).toBe('3 < 4')
  })

  it('does not run off the end of an unterminated tag or comment', () => {
    expect(buildHtmlTextMap('<p>text<div class="oops').text).toBe('text')
    expect(buildHtmlTextMap('<!-- never closed').text).toBe('')
  })
})

describe('locateSelection', () => {
  const source = '<h1>Title</h1>\n<p>The quick brown fox jumps.</p>'
  const map = buildHtmlTextMap(source)

  it('trusts the reported offset when the text is really there', () => {
    const at = map.text.indexOf('quick')
    const found = locateSelection(map, 'quick', at)!
    expect(found.exact).toBe(true)
    expect(source.slice(found.startOffset, found.endOffset)).toBe('quick')
  })

  it('falls back to searching when the offset is stale, and says so', () => {
    // What a DOM the artifact's own scripts rewrote would report.
    const found = locateSelection(map, 'brown', 9999)!
    expect(found.exact).toBe(false)
    expect(source.slice(found.startOffset, found.endOffset)).toBe('brown')
  })

  it('prefers the occurrence nearest the hint when the text repeats', () => {
    const repeated = '<p>fox</p><p>fox</p><p>fox</p>'
    const rmap = buildHtmlTextMap(repeated)
    // Rendered text is 'foxfoxfox'; ask near the third.
    const found = locateSelection(rmap, 'fox', 7)!
    expect(found.startOffset).toBe(repeated.lastIndexOf('fox'))
  })

  it('returns null when the text is nowhere in the source', () => {
    expect(locateSelection(map, 'not present at all', 0)).toBeNull()
    expect(locateSelection(map, '', 0)).toBeNull()
  })

  it('maps a selection spanning tags back to a source range covering them', () => {
    const html = '<p>Some <em>emphasised</em> text</p>'
    const m = buildHtmlTextMap(html)
    const found = locateSelection(m, 'Some emphasised text', 0)!
    expect(found.exact).toBe(true)
    // The range widens over the markup it crossed, which is what a suggestion
    // against this file has to replace.
    expect(html.slice(found.startOffset, found.endOffset)).toBe('Some <em>emphasised</em> text')
  })
})
