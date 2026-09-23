import { describe, expect, it } from 'vitest'
import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs'
import { isTooWideToRender, longestLineIn, MAX_RENDERABLE_LINE } from './longLines'

// Real parser output, not hand-built metadata: the hunk indices and counts are
// the whole question, and a fixture that invents them proves nothing about
// what CodeView is actually handed.
function diff(oldLines: string[], newLines: string[]): FileDiffMetadata {
  const file = (lines: string[]) => ({ name: 'f.yaml', contents: lines.map((l) => l + '\n').join('') })
  return parseDiffFromFile(file(oldLines), file(newLines))
}

const filler = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`)
const long = 'x'.repeat(MAX_RENDERABLE_LINE + 1)

describe('longestLineIn', () => {
  it('measures a changed line on either side', () => {
    expect(longestLineIn(diff(['a'], ['abcd']))).toBe('abcd\n'.length)
    expect(longestLineIn(diff(['abcde'], ['a']))).toBe('abcde\n'.length)
  })

  it('counts hunk context, which renders', () => {
    const lines = [...filler(10), 'y'.repeat(50), 'old', ...filler(10)]
    const changed = [...filler(10), 'y'.repeat(50), 'new', ...filler(10)]
    expect(longestLineIn(diff(lines, changed))).toBe(51)
  })

  it('ignores a line in collapsed context', () => {
    const before = [long, ...filler(40), 'old']
    const after = [long, ...filler(40), 'new']
    expect(longestLineIn(diff(before, after))).toBeLessThan(20)
  })
})

describe('isTooWideToRender', () => {
  it('passes a line exactly at the cap and refuses the one past it', () => {
    // The parser keeps the trailing newline on each line.
    expect(isTooWideToRender(diff(['a'], ['x'.repeat(MAX_RENDERABLE_LINE - 1)]))).toBe(false)
    expect(isTooWideToRender(diff(['a'], ['x'.repeat(MAX_RENDERABLE_LINE)]))).toBe(true)
  })

  // The size of the file is not the question — a minified bundle broken across
  // lines lays out fine, and the same bytes on one line do not.
  it('does not care how many lines there are', () => {
    expect(isTooWideToRender(diff(filler(50_000), [...filler(50_000), 'more']))).toBe(false)
  })

  it('catches a long line on the deletion side too', () => {
    expect(isTooWideToRender(diff([long], ['ok']))).toBe(true)
  })

  it('does not withhold a file for a long line nobody changed', () => {
    const before = [...filler(5), long, ...filler(40), 'old']
    const after = [...filler(5), long, ...filler(40), 'new']
    expect(isTooWideToRender(diff(before, after))).toBe(false)
  })
})
