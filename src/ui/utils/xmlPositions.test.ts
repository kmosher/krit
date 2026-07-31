import { describe, expect, it } from 'vitest'
import { parseXml } from './xmlPositions'

describe('parseXml', () => {
  it('spans an element from its opening bracket to past its closing one', () => {
    const src = '<svg><rect x="1"/></svg>'
    const root = parseXml(src)!
    expect(src.slice(root.start, root.end)).toBe(src)
    const rect = root.children[0]
    expect(rect.kind).toBe('element')
    expect(src.slice(rect.start, rect.end)).toBe('<rect x="1"/>')
  })

  it('reads attributes, including single-quoted and valueless ones', () => {
    const root = parseXml("<svg width='10' hidden data-x=\"y\"/>")!
    expect(root.attributes).toEqual([
      { name: 'width', value: '10' },
      { name: 'hidden', value: 'hidden' },
      { name: 'data-x', value: 'y' },
    ])
  })

  it('spans a text node over its own source, and decodes entities', () => {
    const src = '<svg><text>a &amp; b &#65;</text></svg>'
    const text = (parseXml(src)!.children[0] as { children: Array<{ value: string; start: number; end: number }> })
      .children[0]
    expect(text.value).toBe('a & b A')
    expect(src.slice(text.start, text.end)).toBe('a &amp; b &#65;')
  })

  it('skips declarations, comments and processing instructions', () => {
    const root = parseXml(
      '<?xml version="1.0"?>\n<!DOCTYPE svg>\n<svg><!-- a > b --><rect/></svg>\n',
    )!
    expect(root.name).toBe('svg')
    expect(root.children.map((c) => c.kind === 'element' && c.name)).toEqual(['rect'])
  })

  it('reads CDATA as text', () => {
    const root = parseXml('<svg><style><![CDATA[.a { fill: red }]]></style></svg>')!
    const style = root.children[0] as { children: Array<{ value: string }> }
    expect(style.children[0].value).toBe('.a { fill: red }')
  })

  it('rejects what it cannot trust rather than guessing', () => {
    for (const bad of [
      '<svg>',
      '<svg></rect>',
      '<svg></svg><svg></svg>',
      '<svg><!-- unterminated',
      '<svg attr=unquoted/>',
    ]) {
      expect(parseXml(bad), bad).toBeNull()
    }
  })

  it('allows trailing whitespace after the root, because files end in one', () => {
    expect(parseXml('<svg/>\n')).not.toBeNull()
  })
})
