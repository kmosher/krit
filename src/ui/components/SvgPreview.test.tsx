import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { SvgPreview } from './SvgPreview'
import { anchorForSelection, textNode } from '../utils/previewTestHelpers'

const SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80">
  <rect x="0" y="0" width="200" height="80" fill="#eee"/>
  <text x="10" y="30">Ingest queue</text>
  <text x="10" y="60">Worker pool</text>
</svg>
`

describe('SvgPreview', () => {
  it('anchors a selection on rendered label text back to the source', () => {
    const { container } = render(<SvgPreview source={SOURCE} changedRanges={[]} />)
    const root = container.querySelector('.svg-preview-body')!
    const { anchor, slice } = anchorForSelection(
      root,
      textNode(root, 'Ingest queue'),
      7,
      12,
      SOURCE,
    )
    expect(anchor.selectedText).toBe('queue')
    expect(slice).toBe('queue')
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
