import { describe, it, expect } from 'vitest'
import { computeSingleEdit } from './textEdits'

// Independent oracle: apply an edit the way a text document would, so each
// case asserts on the observable result rather than on offsets we computed
// with the same arithmetic we're testing.
function applyEdit(text: string, edit: ReturnType<typeof computeSingleEdit>): string {
  if (!edit) return text
  const lines = text.split('\n')
  const offsetOf = (pos: { line: number; character: number }) => {
    let offset = 0
    for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1
    return offset + pos.character
  }
  return text.slice(0, offsetOf(edit.range.start)) + edit.newText + text.slice(offsetOf(edit.range.end))
}

describe('computeSingleEdit', () => {
  it('returns null when the texts already match', () => {
    expect(computeSingleEdit('same\ntext\n', 'same\ntext\n')).toBeNull()
  })

  it('narrows a single-line change to just that line', () => {
    const edit = computeSingleEdit('a\nb\nc\n', 'a\nBB\nc\n')
    expect(edit?.range.start).toEqual({ line: 1, character: 0 })
    expect(edit?.range.end).toEqual({ line: 1, character: 1 })
    expect(edit?.newText).toBe('BB')
  })

  it('spans the gap when two distant regions change', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\n'
    const after = 'ONE\ntwo\nthree\nfour\nFIVE\n'
    const edit = computeSingleEdit(before, after)
    expect(edit?.range.start.line).toBe(0)
    expect(edit?.range.end.line).toBe(4)
    expect(applyEdit(before, edit)).toBe(after)
  })

  const cases: Array<[string, string, string]> = [
    ['insertion at the start', '', 'hello'],
    ['insertion at the end', 'hello', 'hello world'],
    ['deletion to empty', 'gone\n', ''],
    ['whole-file rewrite', 'alpha\nbeta\n', 'completely\ndifferent\ncontent\n'],
    ['repeated text, where both ends match the same units', 'ab', 'abab'],
    ['trailing newline added', 'no newline', 'no newline\n'],
    ['trailing newline removed', 'has newline\n', 'has newline'],
    ['CRLF line endings', 'a\r\nb\r\n', 'a\r\nBB\r\n'],
    ['line inserted in the middle', 'a\nc\n', 'a\nb\nc\n'],
    ['line removed from the middle', 'a\nb\nc\n', 'a\nc\n'],
    ['non-ASCII content', 'café\nnaïve\n', 'café\nNAÏVE\n'],
  ]

  it.each(cases)('round-trips: %s', (_name, before, after) => {
    expect(applyEdit(before, computeSingleEdit(before, after))).toBe(after)
  })

  it('never splits a surrogate pair', () => {
    // Two emoji sharing a high surrogate (both are U+1F6.. so their first code
    // unit is identical) — a naive prefix scan stops between the halves.
    const before = 'x🚀y'
    const after = 'x🚁y'
    const edit = computeSingleEdit(before, after)!
    expect(applyEdit(before, edit)).toBe(after)
    // The proof it didn't split: no lone surrogate survived the round trip.
    expect([...applyEdit(before, edit)]).toEqual([...after])
  })

  // Pierre cannot express a position between \r and \n, so neither boundary
  // may land there. Normalizing line endings is the way this shows up.
  it.each([
    ['CRLF normalized to LF', 'a\r\nb\r\n', 'a\nb\n'],
    ['LF converted to CRLF', 'a\nb\n', 'a\r\nb\r\n'],
    ['one CRLF line ending dropped', 'a\r\n', 'a\n'],
  ])('keeps both boundaries off the CR/LF gap: %s', (_name, before, after) => {
    const edit = computeSingleEdit(before, after)!
    for (const pos of [edit.range.start, edit.range.end]) {
      // Splitting a line on \n leaves the \r at the end of the preceding
      // piece, so the forbidden gap is exactly "at end-of-line, on a line that
      // ends in \r". A character offset that merely *reads* as \r is the legal
      // position just before it.
      const line = before.split('\n')[pos.line] ?? ''
      expect(line.endsWith('\r') && pos.character === line.length).toBe(false)
    }
    expect(applyEdit(before, edit)).toBe(after)
  })

  it('reports positions against the old text, not the new one', () => {
    // The end position must index the OLD document — a shrinking edit whose
    // end was computed against the new text would land short and leave a tail.
    const before = 'keep\ndelete me entirely\nkeep\n'
    const after = 'keep\nx\nkeep\n'
    const edit = computeSingleEdit(before, after)!
    expect(edit.range.end.line).toBe(1)
    expect(applyEdit(before, edit)).toBe(after)
  })
})
