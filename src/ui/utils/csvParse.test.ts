import { describe, expect, it } from 'vitest'
import { delimiterFor, parseDelimited } from './csvParse'

const texts = (source: string, delimiter = ',') =>
  parseDelimited(source, delimiter).map((r) => r.cells.map((c) => c.text))

describe('parseDelimited', () => {
  it('reads rows and fields', () => {
    expect(texts('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('does not invent a row for a trailing newline, or lose one without it', () => {
    expect(texts('a,b\n')).toEqual([['a', 'b']])
    expect(texts('a,b')).toEqual([['a', 'b']])
  })

  it('keeps an empty trailing field', () => {
    expect(texts('a,')).toEqual([['a', '']])
    expect(texts('a,,b')).toEqual([['a', '', 'b']])
  })

  it('reads a quoted field, including its delimiters and newlines', () => {
    expect(texts('"a,b",c\n')).toEqual([['a,b', 'c']])
    expect(texts('"two\nlines",c\n')).toEqual([['two\nlines', 'c']])
    expect(texts('"say ""hi""",c\n')).toEqual([['say "hi"', 'c']])
  })

  it('numbers a row by the lines it really occupies', () => {
    const rows = parseDelimited('h1,h2\n"two\nlines",b\nlast,x\n', ',')
    expect(rows.map((r) => [r.startLine, r.endLine])).toEqual([
      [1, 1],
      [2, 3],
      [4, 4],
    ])
  })

  it('spans each field so its text can be found in its own source', () => {
    const source = 'name,note\nada,"a, b"\n'
    for (const row of parseDelimited(source, ',')) {
      for (const cell of row.cells) {
        expect(source.slice(cell.start, cell.end)).toContain(cell.text)
      }
    }
  })

  it('strips the CR of a CRLF file rather than carrying it into a field', () => {
    expect(texts('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  // The CRLF case above passes with the terminator consumed twice; this one
  // does not. A quoted last field is what Excel and most database exports
  // write, and the doubled terminator gave every such row an empty trailing
  // cell plus a CR in the last one — a whole junk column, misaligned against
  // the header, on the most ordinary CSV there is.
  it('strips the CR after a quoted field, and opens no cell for it', () => {
    expect(texts('"a","b"\r\n"c","d"\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('keeps text written after a closing quote in the same cell', () => {
    expect(texts('"ab"xy,z')).toEqual([['abxy', 'z']])
  })

  it('treats a blank line as a separator, not a row of one empty field', () => {
    expect(texts('a,b\n\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('still numbers rows by their real lines when a blank line is skipped', () => {
    const rows = parseDelimited('a,b\n\nc,d\n', ',')
    expect(rows.map((r) => r.startLine)).toEqual([1, 3])
  })

  it('yields no rows for an empty file', () => {
    expect(parseDelimited('', ',')).toEqual([])
  })

  it('picks the delimiter off the extension', () => {
    expect(delimiterFor('data/x.csv')).toBe(',')
    expect(delimiterFor('data/x.tsv')).toBe('\t')
    expect(delimiterFor('data/x.TAB')).toBe('\t')
  })
})
