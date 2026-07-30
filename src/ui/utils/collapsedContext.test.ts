import { describe, it, expect } from 'vitest'
import type { FileDiffMetadata, Hunk } from '@pierre/diffs'
import { additionLineForAnchor, linesToReveal } from './collapsedContext'

// `@@ -deletionStart,deletionCount +additionStart,additionCount @@`, which is
// all of a hunk this translation reads.
function hunk(
  deletionStart: number,
  deletionCount: number,
  additionStart: number,
  additionCount: number,
): Hunk {
  return { deletionStart, deletionCount, additionStart, additionCount } as unknown as Hunk
}

function diff(...hunks: Hunk[]): Pick<FileDiffMetadata, 'hunks'> {
  return { hunks } as unknown as Pick<FileDiffMetadata, 'hunks'>
}

// One insertion of two lines at new-file line 12, and one later hunk that
// deletes a line: old 20-24 becomes new 22-25.
const twoHunks = diff(hunk(10, 5, 12, 7), hunk(20, 5, 22, 4))

describe('additionLineForAnchor', () => {
  it('passes an addition-side line straight through', () => {
    expect(additionLineForAnchor(twoHunks, 'additions', 40)).toBe(40)
  })

  it('shifts a deletion-side line in the gap before a hunk by that hunk offset', () => {
    // Old line 7 is unchanged context ahead of a hunk that starts +2 across.
    expect(additionLineForAnchor(twoHunks, 'deletions', 7)).toBe(9)
  })

  it('shifts a deletion-side line in the gap between two hunks', () => {
    // Old 17 sits after the first hunk (ends at old 14) and before the second
    // (starts at old 20), so it takes the second hunk's +2 offset.
    expect(additionLineForAnchor(twoHunks, 'deletions', 17)).toBe(19)
  })

  it('returns null for a deletion-side line inside a hunk', () => {
    // Already rendered — a hunk's own lines are never in a collapsed region.
    expect(additionLineForAnchor(twoHunks, 'deletions', 12)).toBeNull()
    expect(additionLineForAnchor(twoHunks, 'deletions', 22)).toBeNull()
  })

  it('carries the whole file delta into the trailing region', () => {
    // Old 30 is past both hunks: +2 from the first, -1 from the second.
    expect(additionLineForAnchor(twoHunks, 'deletions', 30)).toBe(31)
  })

  it('returns null for a file-level anchor', () => {
    // `lineNumber: 0` means "the file" (the rendered preview), not a line.
    expect(additionLineForAnchor(twoHunks, 'additions', 0)).toBeNull()
    expect(additionLineForAnchor(twoHunks, 'deletions', 0)).toBeNull()
  })

  it('returns null for a file with no hunks', () => {
    // The emptied body a rendered preview stands in for has no rows at all,
    // so there is no collapsed region to open.
    expect(additionLineForAnchor(diff(), 'additions', 5)).toBeNull()
  })
})

describe('linesToReveal', () => {
  it('collects both sides and drops what needs no reveal', () => {
    expect(
      linesToReveal(twoHunks, [
        { side: 'additions', lineNumber: 40 },
        { side: 'deletions', lineNumber: 7 },
        { side: 'deletions', lineNumber: 12 }, // inside a hunk
        { side: 'additions', lineNumber: 0 }, // file-level
      ]),
    ).toEqual([40, 9])
  })

  it('deduplicates lines two anchors resolve to', () => {
    // A comment and its open reply form both anchor to the same line; the
    // second reveal would be a no-op but still walks every hunk.
    expect(
      linesToReveal(twoHunks, [
        { side: 'additions', lineNumber: 9 },
        { side: 'deletions', lineNumber: 7 },
      ]),
    ).toEqual([9])
  })
})
