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

  it('ignores a CRLF line ending when counting columns', () => {
    // The \r is not a column either: counting it would reserve two rows for
    // every full-width line in a CRLF repo.
    expect(estimateWrappedRowHeight([file(['x'.repeat(100) + '\r\n'])], metrics)).toBe(20)
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
    const long = [file(['x'.repeat(500) + '\n'])]
    expect(estimateWrappedRowHeight(long, { rowHeight: 20, charsPerRow: 0 })).toBe(20)
    // An unpainted surface measures a 0 row height, and the result feeds
    // computeRowWindow as its lineHeight — which clamps rather than dividing by
    // it. Sub-pixel char widths come off the same unpainted surface, and with
    // one the unguarded arithmetic is 0 * Infinity, i.e. NaN.
    expect(estimateWrappedRowHeight(long, { rowHeight: 0, charsPerRow: 100 })).toBe(0)
    expect(
      estimateWrappedRowHeight(long, { rowHeight: 0, charsPerRow: Number.MIN_VALUE }),
    ).toBe(0)
  })

  it('samples a bounded number of lines from a very large file', () => {
    // The long lines sit at an offset the even stride never lands on, so the
    // sampled average (1 row/line, 20px) and the full-walk average (1.49
    // rows/line, 30px) can't agree by construction — a uniform fixture would
    // pass with the sampling removed.
    const lines = Array.from({ length: 200_000 }, (_, i) =>
      i % 100 === 50 ? 'x'.repeat(5000) + '\n' : 'short\n',
    )
    expect(estimateWrappedRowHeight([file(lines)], metrics)).toBe(20)
  })
})
