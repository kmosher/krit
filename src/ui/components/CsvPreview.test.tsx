import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CsvPreview } from './CsvPreview'
import { anchorForSelection, textNode } from '../utils/previewTestHelpers'

const SOURCE = 'name,note\nada,"first, and best"\ngrace,compiler\n'

function anchorOf(container: HTMLElement, text: string, from: number, to: number) {
  const root = container.querySelector('.csv-preview-body')!
  return anchorForSelection(root, textNode(container, text), from, to, SOURCE)
}

describe('CsvPreview', () => {
  it('anchors a selection in an unquoted field exactly', () => {
    const { container } = render(
      <CsvPreview source={SOURCE} delimiter="," changedRanges={[]} />,
    )
    const { anchor, slice } = anchorOf(container, 'compiler', 0, 8)
    expect(anchor.startLine).toBe(3)
    expect(slice).toBe('compiler')
  })

  it('anchors inside a quoted field past its opening quote', () => {
    const { container } = render(
      <CsvPreview source={SOURCE} delimiter="," changedRanges={[]} />,
    )
    const { slice } = anchorOf(container, 'first, and best', 0, 5)
    expect(slice).toBe('first')
  })

  it('marks the rows the diff touched', () => {
    const { container } = render(
      <CsvPreview source={SOURCE} delimiter="," changedRanges={[[3, 3]]} />,
    )
    const marked = container.querySelectorAll('tr[data-changed]')
    expect(marked.length).toBe(1)
    expect(marked[0].textContent).toContain('grace')
  })

  it('gives the line-number column no source span, so it cannot be anchored on', () => {
    const { container } = render(
      <CsvPreview source={SOURCE} delimiter="," changedRanges={[]} />,
    )
    for (const el of container.querySelectorAll('.csv-preview-lineno')) {
      expect(el.getAttribute('data-src')).toBeNull()
    }
  })

  it('says the file is empty rather than rendering an empty table', () => {
    const { container } = render(<CsvPreview source="" delimiter="," changedRanges={[]} />)
    expect(container.querySelector('.csv-preview-empty')).not.toBeNull()
  })
})
