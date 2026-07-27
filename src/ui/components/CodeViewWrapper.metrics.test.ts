import { describe, it, expect } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import { estimateWrappedRowHeight } from './CodeViewWrapper'

function file(additionLines: string[], deletionLines: string[] = []): FileDiffMetadata {
  return { additionLines, deletionLines } as unknown as FileDiffMetadata
}

const metrics = { rowHeight: 20, charsPerRow: 100 }

describe('estimateWrappedRowHeight', () => {
  it('reserves one row per line when nothing wraps', () => {
    expect(estimateWrappedRowHeight([file(['a\n', 'bb\n', 'ccc\n'])], metrics)).toBe(20)
  })

  it('reserves the wrapped row count for long lines', () => {
    // 250 chars over a 100-char row is 3 rows; averaged with one short line
    // that is 2 rows per line.
    expect(estimateWrappedRowHeight([file(['x'.repeat(250) + '\n', 'short\n'])], metrics)).toBe(40)
  })

  it('ignores the trailing newline when counting columns', () => {
    // Exactly one row's worth of text plus its newline must not count as two.
    expect(estimateWrappedRowHeight([file(['x'.repeat(100) + '\n'])], metrics)).toBe(20)
  })

  it('rounds up, so the estimate never reserves less than the average', () => {
    // Two lines, three rows: 1.5 rows/line = 30px exactly; three lines, four
    // rows: 1.333 rows/line = 26.67px, which must round up to 27.
    expect(
      estimateWrappedRowHeight([file(['x'.repeat(150) + '\n', 'a\n', 'b\n'])], metrics),
    ).toBe(27)
  })

  it('counts deletion lines too', () => {
    expect(estimateWrappedRowHeight([file(['a\n'], ['x'.repeat(300) + '\n'])], metrics)).toBe(40)
  })

  it('averages across files', () => {
    expect(
      estimateWrappedRowHeight([file(['x'.repeat(200) + '\n']), file(['a\n'])], metrics),
    ).toBe(30)
  })

  it('falls back to the row height when there is nothing to sample', () => {
    expect(estimateWrappedRowHeight([], metrics)).toBe(20)
    expect(estimateWrappedRowHeight([file([])], metrics)).toBe(20)
  })

  it('falls back to the row height when the surface measurement is unusable', () => {
    expect(estimateWrappedRowHeight([file(['x'.repeat(500) + '\n'])], { rowHeight: 20, charsPerRow: 0 })).toBe(20)
  })

  it('samples a bounded number of lines from a very large file', () => {
    const lines = Array.from({ length: 200_000 }, () => 'x'.repeat(200) + '\n')
    expect(estimateWrappedRowHeight([file(lines)], metrics)).toBe(40)
  })
})
