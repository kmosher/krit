import { describe, expect, it } from 'vitest'
import { delimiterFor, parseDelimited } from './csvPreview'

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

  it('yields no rows for an empty file', () => {
    expect(parseDelimited('', ',')).toEqual([])
  })

  it('picks the delimiter off the extension', () => {
    expect(delimiterFor('data/x.csv')).toBe(',')
    expect(delimiterFor('data/x.tsv')).toBe('\t')
    expect(delimiterFor('data/x.TAB')).toBe('\t')
  })
})
