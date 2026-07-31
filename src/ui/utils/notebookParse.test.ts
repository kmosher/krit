import { describe, expect, it } from 'vitest'
import { parseNotebook, toFileOffset } from './notebookParse'

const NOTEBOOK = JSON.stringify(
  {
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: ['# Title\n', '\n', 'Some **bold** prose.\n'],
      },
      {
        cell_type: 'code',
        execution_count: 7,
        metadata: {},
        source: ['import os\n', 'print(os.name)\n'],
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['posix\n'] },
          { output_type: 'execute_result', data: { 'text/plain': ['42'] }, metadata: {} },
          {
            output_type: 'display_data',
            data: { 'image/png': 'aGk=', 'text/plain': ['<Figure>'] },
            metadata: {},
          },
          { output_type: 'error', ename: 'ValueError', evalue: 'nope', traceback: ['line one'] },
        ],
      },
    ],
    metadata: { kernelspec: { language: 'python' } },
    nbformat: 4,
  },
  null,
  1,
)

describe('parseNotebook', () => {
  it('reads cells, joining a split source into one text', () => {
    const nb = parseNotebook(NOTEBOOK)!
    expect(nb.language).toBe('python')
    expect(nb.cells.map((c) => c.type)).toEqual(['markdown', 'code'])
    expect(nb.cells[0].source.text).toBe('# Title\n\nSome **bold** prose.\n')
    expect(nb.cells[1].source.text).toBe('import os\nprint(os.name)\n')
    expect(nb.cells[1].executionCount).toBe(7)
  })

  it('points every decoded character at the file offset it was written at', () => {
    const nb = parseNotebook(NOTEBOOK)!
    const cell = nb.cells[0]
    // The anchoring contract in one assertion: a run of cell text is found at
    // the file offsets its map reports.
    const at = cell.source.text.indexOf('**bold**')
    const from = toFileOffset(cell.source, at)
    expect(NOTEBOOK.slice(from, from + 8)).toBe('**bold**')
  })

  it('clamps an offset past the end to the value it came from', () => {
    const cell = parseNotebook(NOTEBOOK)!.cells[0]
    const past = toFileOffset(cell.source, cell.source.text.length + 50)
    expect(past).toBe(cell.source.end)
    expect(past).toBeLessThanOrEqual(NOTEBOOK.length)
  })

  it('reports the file lines a cell occupies, so a diff can mark it', () => {
    const nb = parseNotebook(NOTEBOOK)!
    for (const cell of nb.cells) {
      expect(cell.startLine).toBeLessThanOrEqual(cell.endLine)
      const lines = NOTEBOOK.split('\n')
      expect(lines.slice(cell.startLine - 1, cell.endLine).join('\n')).toContain('source')
    }
  })

  it('renders the output kinds it can and drops the rest', () => {
    const outputs = parseNotebook(NOTEBOOK)!.cells[1].outputs
    expect(outputs).toEqual([
      { kind: 'text', text: 'posix\n', stream: 'stdout' },
      { kind: 'text', text: '42' },
      { kind: 'image', mime: 'image/png', data: 'aGk=' },
      { kind: 'error', text: 'line one' },
    ])
  })

  it('never renders kernel-authored HTML', () => {
    const nb = JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          source: ['x\n'],
          outputs: [{ output_type: 'display_data', data: { 'text/html': '<script>x</script>' } }],
        },
      ],
    })
    expect(parseNotebook(nb)!.cells[0].outputs).toEqual([])
  })

  it('accepts a source written as one string, not an array', () => {
    const nb = JSON.stringify({ cells: [{ cell_type: 'markdown', source: 'hello\nthere' }] })
    const cell = parseNotebook(nb)!.cells[0]
    expect(cell.source.text).toBe('hello\nthere')
    const at = toFileOffset(cell.source, 6)
    expect(nb.slice(at, at + 5)).toBe('there')
  })

  it('returns null for anything that is not a notebook', () => {
    expect(parseNotebook('not json')).toBeNull()
    expect(parseNotebook('{"cells": {}}')).toBeNull()
    expect(parseNotebook('[]')).toBeNull()
  })
})
