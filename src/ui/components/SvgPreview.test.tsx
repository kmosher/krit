import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { SvgPreview } from './SvgPreview'
import { buildLineIndex, lineColToOffset, previewRangeToAnchor } from '../utils/previewAnchor'

const SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80">
  <rect x="0" y="0" width="200" height="80" fill="#eee"/>
  <text x="10" y="30">Ingest queue</text>
  <text x="10" y="60">Worker pool</text>
</svg>
`

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

describe('SvgPreview', () => {
  it('anchors a selection on rendered label text back to the source', () => {
    const { container } = render(<SvgPreview source={SOURCE} changedRanges={[]} />)
    const root = container.querySelector('.svg-preview-body')!
    const node = textNode(root, 'Ingest queue')
    const range = document.createRange()
    range.setStart(node, 7)
    range.setEnd(node, 12)
    const anchor = previewRangeToAnchor(range, root, SOURCE, buildLineIndex(SOURCE))!
    expect(anchor.selectedText).toBe('queue')
    const starts = buildLineIndex(SOURCE)
    expect(
      SOURCE.slice(
        lineColToOffset(starts, anchor.startLine, anchor.startColumn),
        lineColToOffset(starts, anchor.endLine, anchor.endColumn),
      ),
    ).toBe('queue')
    expect(anchor.startLine).toBe(3)
  })

  it('marks the innermost changed element, not every ancestor of it', () => {
    const { container } = render(<SvgPreview source={SOURCE} changedRanges={[[4, 4]]} />)
    const marked = container.querySelectorAll('[data-changed]')
    expect(marked.length).toBe(1)
    expect(marked[0].textContent).toBe('Worker pool')
  })

  it('says what it refused to draw instead of showing a quietly wrong picture', () => {
    const withScript = SOURCE.replace('<rect', '<script>alert(1)</script>\n  <rect')
    const { container } = render(<SvgPreview source={withScript} changedRanges={[]} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('.svg-preview-removed')!.textContent).toContain('script')
  })

  it('says so rather than rendering nothing when the file is not well-formed', () => {
    const { container } = render(<SvgPreview source="<svg><rect>" changedRanges={[]} />)
    expect(container.querySelector('.svg-preview-error')).not.toBeNull()
  })
})
