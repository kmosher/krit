import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { NotebookPreview } from './NotebookPreview'
import { previewRangeToAnchor } from '../utils/previewAnchor'
import { anchorForSelection, sliceForAnchor, textNode } from '../utils/previewTestHelpers'

// The notebook path's whole risk is the extra hop: rendered offsets go through
// a cell's JSON string map before they mean anything about the file. These
// check the round trip against a real render — select rendered text, and see
// whether the anchor slices the same text back out of the `.ipynb` itself.

const SOURCE = JSON.stringify(
  {
    cells: [
      { cell_type: 'markdown', source: ['# Notes\n', '\n', 'Some **bold** prose.\n'] },
      { cell_type: 'code', execution_count: 1, source: ['import os\n', 'print(os.name)\n'], outputs: [] },
    ],
    metadata: {},
    nbformat: 4,
  },
  null,
  1,
)

describe('NotebookPreview', () => {
  it('anchors a selection in a markdown cell to the JSON the cell was written in', () => {
    const { container } = render(<NotebookPreview source={SOURCE} changedRanges={[]} />)
    const root = container.querySelector('.notebook-preview-body')!
    const { anchor, slice } = anchorForSelection(root, textNode(root, 'bold'), 0, 4, SOURCE)
    expect(anchor.selectedText).toBe('bold')
    expect(slice).toBe('bold')
  })

  it('anchors a selection in a code cell to that line of the cell source', () => {
    const { container } = render(<NotebookPreview source={SOURCE} changedRanges={[]} />)
    const root = container.querySelector('.notebook-preview-body')!
    const { anchor, slice } = anchorForSelection(
      root,
      textNode(root, 'print(os.name)'),
      6,
      13,
      SOURCE,
    )
    expect(anchor.selectedText).toBe('os.name')
    expect(slice).toBe('os.name')
  })

  it('marks the cells the diff touched, and only those', () => {
    const codeLine = SOURCE.split('\n').findIndex((l) => l.includes('print(os.name)')) + 1
    const { container } = render(
      <NotebookPreview source={SOURCE} changedRanges={[[codeLine, codeLine]]} />,
    )
    expect(container.querySelector('.notebook-cell-source[data-changed]')).not.toBeNull()
    // The markdown cell is above the changed line and must stay unmarked.
    const markdownBody = container.querySelector('.markdown-preview-body')!
    expect(markdownBody.querySelector('[data-changed]')).toBeNull()
  })

  it('leaves outputs unstamped, so a selection in one yields no anchor at all', () => {
    const withOutput = JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          source: ['x\n'],
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['printed\n'] }],
        },
      ],
    })
    const { container } = render(<NotebookPreview source={withOutput} changedRanges={[]} />)
    const root = container.querySelector('.notebook-preview-body')!
    const out = container.querySelector('.notebook-output pre')!
    expect(out.closest('[data-src]')).toBeNull()

    const node = textNode(out, 'printed\n')
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 7)
    expect(previewRangeToAnchor(range, root, withOutput)).toBeNull()
  })

  it('says so rather than rendering nothing when the file is not a notebook', () => {
    const { container } = render(<NotebookPreview source={'{ not json'} changedRanges={[]} />)
    expect(container.querySelector('.notebook-preview-error')).not.toBeNull()
  })
})
