import { describe, it, expect } from 'vitest'
import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs'
import { spliceCommentIslands } from './commentIslands'

// These run against real `parseDiffFromFile` output rather than hand-built
// fixtures. The whole approach rests on how Pierre numbers hunks, and a fixture
// would only ever prove the splice agrees with my reading of that — not with
// the library. `checkLayout` is the load-bearing assertion, and it is applied
// to upstream's own output first so a failure tells you which side moved.

function fileOf(lines: string[]): { name: string; contents: string } {
  return { name: 'p.txt', contents: lines.join('\n') + '\n' }
}

/** 400 unchanged lines with `changed` (0-based) rewritten on the new side. */
function diffWithChangesAt(...changed: number[]): FileDiffMetadata {
  const oldLines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`)
  const newLines = oldLines.slice()
  for (const at of changed) newLines[at] = `line ${at + 1} CHANGED`
  return parseDiffFromFile(fileOf(oldLines), fileOf(newLines))
}

/**
 * Every hunk's declared start must equal the running total of the hunks before
 * it plus its own collapsed region, and the file's totals must cover the last
 * hunk plus whatever trails it. This is the contract an invented hunk has to
 * keep; break it and Pierre lays rows out on top of each other.
 */
function checkLayout(fileDiff: FileDiffMetadata) {
  let split = 0
  let unified = 0
  for (const hunk of fileDiff.hunks) {
    expect(hunk.splitLineStart).toBe(split + hunk.collapsedBefore)
    expect(hunk.unifiedLineStart).toBe(unified + hunk.collapsedBefore)
    split = hunk.splitLineStart + hunk.splitLineCount
    unified = hunk.unifiedLineStart + hunk.unifiedLineCount
  }
  const last = fileDiff.hunks[fileDiff.hunks.length - 1]
  const trailing = fileDiff.additionLines.length - (last.additionStart + last.additionCount - 1)
  expect(fileDiff.splitLineCount).toBe(split + trailing)
  expect(fileDiff.unifiedLineCount).toBe(unified + trailing)
}

describe('spliceCommentIslands', () => {
  it('the layout contract holds for upstream output as written', () => {
    // If this ever fails, the model the splice is built on has changed and the
    // rest of this file is measuring the wrong thing.
    checkLayout(diffWithChangesAt(3, 298))
  })

  it('renders an island around a line stranded mid-gap', () => {
    const diff = diffWithChangesAt(3, 298)
    const islanded = spliceCommentIslands(diff, [150])
    expect(islanded).not.toBe(diff)
    expect(islanded.hunks).toHaveLength(3)

    const island = islanded.hunks[1]
    expect(island.additionStart).toBe(144)
    expect(island.additionCount).toBe(13)
    // Context only — an island must never claim a line as added or deleted.
    expect(island.additionLines).toBe(0)
    expect(island.deletionLines).toBe(0)
    expect(island.hunkContent).toEqual([
      { type: 'context', lines: 13, additionLineIndex: 143, deletionLineIndex: 143 },
    ])
  })

  it('leaves a collapsed region on both sides of the island', () => {
    const islanded = spliceCommentIslands(diffWithChangesAt(3, 298), [150])
    expect(islanded.hunks[1].collapsedBefore).toBeGreaterThan(0)
    expect(islanded.hunks[2].collapsedBefore).toBeGreaterThan(0)
  })

  it('keeps the layout contract after splicing', () => {
    checkLayout(spliceCommentIslands(diffWithChangesAt(3, 298), [150]))
  })

  it('does not move any following hunk', () => {
    const diff = diffWithChangesAt(3, 298)
    const islanded = spliceCommentIslands(diff, [150])
    const before = diff.hunks[1]
    const after = islanded.hunks[2]
    // Only the boundary with the island moved; where the hunk renders did not.
    expect(after.splitLineStart).toBe(before.splitLineStart)
    expect(after.unifiedLineStart).toBe(before.unifiedLineStart)
    expect(after.additionStart).toBe(before.additionStart)
    expect(after.collapsedBefore).not.toBe(before.collapsedBefore)
  })

  it('merges anchors close enough for their islands to touch', () => {
    const islanded = spliceCommentIslands(diffWithChangesAt(3, 298), [150, 158])
    expect(islanded.hunks).toHaveLength(3)
    expect(islanded.hunks[1].additionStart).toBe(144)
    expect(islanded.hunks[1].additionCount).toBe(21)
    checkLayout(islanded)
  })

  it('renders separate islands for anchors far apart in one gap', () => {
    const islanded = spliceCommentIslands(diffWithChangesAt(3, 298), [100, 200])
    expect(islanded.hunks).toHaveLength(4)
    expect(islanded.hunks[1].additionStart).toBe(94)
    expect(islanded.hunks[2].additionStart).toBe(194)
    checkLayout(islanded)
  })

  it('islands the leading region before the first hunk', () => {
    const diff = diffWithChangesAt(299)
    const islanded = spliceCommentIslands(diff, [100])
    expect(islanded.hunks).toHaveLength(2)
    expect(islanded.hunks[0].additionStart).toBe(94)
    expect(islanded.hunks[0].collapsedBefore).toBe(93)
    checkLayout(islanded)
  })

  it('islands the trailing region after the last hunk', () => {
    const diff = diffWithChangesAt(3)
    const islanded = spliceCommentIslands(diff, [350])
    expect(islanded.hunks).toHaveLength(2)
    expect(islanded.hunks[1].additionStart).toBe(344)
    checkLayout(islanded)
  })

  it('maps the deletion side through the gap offset', () => {
    // Two lines inserted at old line 51, so everything after it sits two lines
    // later on the new side and an island must say so or the left column
    // renders the wrong text.
    const oldLines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`)
    const newLines = oldLines.slice()
    newLines.splice(50, 0, 'inserted a', 'inserted b')
    const diff = parseDiffFromFile(fileOf(oldLines), fileOf(newLines))
    const islanded = spliceCommentIslands(diff, [200])
    const island = islanded.hunks[1]
    expect(island.additionStart).toBe(194)
    expect(island.deletionStart).toBe(192)
    checkLayout(islanded)
  })

  it('leaves a short gap to the reveal path', () => {
    // Changes 30 lines apart: opening that gap is cheaper than two separators.
    const diff = diffWithChangesAt(100, 130)
    expect(spliceCommentIslands(diff, [115])).toBe(diff)
  })

  it('leaves a line already inside a hunk alone', () => {
    const diff = diffWithChangesAt(3, 298)
    expect(spliceCommentIslands(diff, [4])).toBe(diff)
  })

  it('returns the original for a partial diff', () => {
    // No full-file content behind the gaps, so an island would render nothing.
    const diff = { ...diffWithChangesAt(3, 298), isPartial: true }
    expect(spliceCommentIslands(diff, [150])).toBe(diff)
  })

  it('returns the original when there are no anchors', () => {
    const diff = diffWithChangesAt(3, 298)
    expect(spliceCommentIslands(diff, [])).toBe(diff)
  })

  it('takes a fresh cache key, since the row layout changed', () => {
    const diff = diffWithChangesAt(3, 298)
    const islanded = spliceCommentIslands(diff, [150])
    expect(islanded.cacheKey).not.toBe(diff.cacheKey)
    // Same anchors must produce the same key, or every render invalidates the
    // highlight cache for the whole file.
    expect(spliceCommentIslands(diff, [150]).cacheKey).toBe(islanded.cacheKey)
  })
})
