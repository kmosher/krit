import { describe, expect, it } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import { isTooWideToRender, longestLineIn, MAX_RENDERABLE_LINE } from './longLines'

function fileWith(additionLines: string[], deletionLines: string[] = []): FileDiffMetadata {
  return { additionLines, deletionLines } as FileDiffMetadata
}

describe('longestLineIn', () => {
  it('measures both sides', () => {
    expect(longestLineIn(fileWith(['ab'], ['abcd']))).toBe(4)
    expect(longestLineIn(fileWith(['abcde'], ['a']))).toBe(5)
  })

  it('is zero for a file with no lines on either side', () => {
    expect(longestLineIn(fileWith([]))).toBe(0)
  })
})

describe('isTooWideToRender', () => {
  it('passes a line exactly at the cap and refuses the one past it', () => {
    expect(isTooWideToRender(fileWith(['x'.repeat(MAX_RENDERABLE_LINE)]))).toBe(false)
    expect(isTooWideToRender(fileWith(['x'.repeat(MAX_RENDERABLE_LINE + 1)]))).toBe(true)
  })

  // The size of the file is not the question — a minified bundle broken across
  // lines lays out fine, and the same bytes on one line do not.
  it('does not care how many lines there are', () => {
    expect(isTooWideToRender(fileWith(Array(50_000).fill('a normal line of code')))).toBe(false)
  })

  it('catches a long line on the deletion side too', () => {
    expect(isTooWideToRender(fileWith(['ok'], ['x'.repeat(MAX_RENDERABLE_LINE + 1)]))).toBe(true)
  })
})
