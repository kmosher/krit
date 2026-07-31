import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { NotebookPreview } from './NotebookPreview'
import { buildLineIndex, lineColToOffset, previewRangeToAnchor } from '../utils/previewAnchor'

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

/** The file text an anchor's line/column range points at. */
function sliceFor(anchor: NonNullable<ReturnType<typeof previewRangeToAnchor>>): string {
  const starts = buildLineIndex(SOURCE)
  return SOURCE.slice(
    lineColToOffset(starts, anchor.startLine, anchor.startColumn),
    lineColToOffset(starts, anchor.endLine, anchor.endColumn),
  )
}

function selectWithin(node: Text, from: number, to: number, root: Element) {
  const range = document.createRange()
  range.setStart(node, from)
  range.setEnd(node, to)
  return previewRangeToAnchor(range, root, SOURCE, buildLineIndex(SOURCE))
}

describe('NotebookPreview', () => {
  it('anchors a selection in a markdown cell to the JSON the cell was written in', () => {
    const { container } = render(<NotebookPreview source={SOURCE} changedRanges={[]} />)
    const root = container.querySelector('.notebook-preview-body')!
    const anchor = selectWithin(textNode(root, 'bold'), 0, 4, root)!
    expect(anchor.selectedText).toBe('bold')
    expect(sliceFor(anchor)).toBe('bold')
  })

  it('anchors a selection in a code cell to that line of the cell source', () => {
    const { container } = render(<NotebookPreview source={SOURCE} changedRanges={[]} />)
    const root = container.querySelector('.notebook-preview-body')!
    const anchor = selectWithin(textNode(root, 'print(os.name)'), 6, 13, root)!
    expect(anchor.selectedText).toBe('os.name')
    expect(sliceFor(anchor)).toBe('os.name')
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
