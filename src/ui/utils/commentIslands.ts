import type { FileDiffMetadata, Hunk } from '@pierre/diffs'

// Pierre can only open a collapsed gap from its two edges — `HunkExpansionRegion`
// is `{fromStart, fromEnd}` and there is no third window — so revealing a
// comment stranded mid-gap renders every line between it and the nearer hunk.
// A hunk's own lines, by contrast, always render. So rather than open the gap,
// split it: a context-only hunk around the anchor leaves a small island of real
// rows with a collapsed region still on either side.
//
// The splice is local. An island consumes exactly the lines it takes out of the
// following hunk's `collapsedBefore`, so every later hunk's `splitLineStart`
// and `unifiedLineStart` come out unchanged and the file's totals hold. That is
// checked against real `parseDiffFromFile` output in the tests rather than
// assumed, because nothing upstream promises it.

/** Context rows rendered either side of an anchored line. */
const ISLAND_RADIUS = 6

// Gaps this size or smaller are left to the reveal path in CodeViewWrapper.
// Two separators wrapped around a thirteen-row island cost more attention than
// simply opening a short gap, and the expansion there is cheap anyway.
const MIN_ISLANDED_GAP = 60

interface LineRange {
  start: number
  end: number
}

interface Gap extends LineRange {
  /**
   * Index into `hunks` of the hunk this gap precedes — `hunks.length` for the
   * trailing region, which has no follower to renumber.
   */
  before: number
  /** `oldLine = newLine + delta` for every line in the gap; it is unchanged. */
  delta: number
}

function gapsOf(fileDiff: FileDiffMetadata): Gap[] {
  const hunks = fileDiff.hunks
  const gaps: Gap[] = []
  hunks.forEach((hunk, index) => {
    if (hunk.collapsedBefore <= 0) return
    gaps.push({
      before: index,
      start: hunk.additionStart - hunk.collapsedBefore,
      end: hunk.additionStart - 1,
      delta: hunk.deletionStart - hunk.additionStart,
    })
  })
  const last = hunks[hunks.length - 1]
  const trailingStart = last.additionStart + last.additionCount
  const total = fileDiff.additionLines.length
  if (trailingStart <= total) {
    gaps.push({
      before: hunks.length,
      start: trailingStart,
      end: total,
      delta: last.deletionStart + last.deletionCount - trailingStart,
    })
  }
  return gaps
}

function islandHunk(range: LineRange, delta: number, prev: Hunk | undefined): Hunk {
  const count = range.end - range.start + 1
  // A file starts at line 1, so with no hunk ahead of it the island's collapsed
  // region is everything back to the top.
  const prevEnd = prev ? prev.additionStart + prev.additionCount : 1
  const collapsedBefore = range.start - prevEnd
  const deletionStart = range.start + delta
  const additionLineIndex = range.start - 1
  const deletionLineIndex = deletionStart - 1
  return {
    collapsedBefore,
    additionStart: range.start,
    additionCount: count,
    // Zero on both sides: an island is context by construction, which is what
    // makes it safe to invent — it claims no line the diff did not already have.
    additionLines: 0,
    deletionLines: 0,
    additionLineIndex,
    deletionStart,
    deletionCount: count,
    deletionLineIndex,
    hunkContent: [{ type: 'context', lines: count, additionLineIndex, deletionLineIndex }],
    hunkSpecs: `@@ -${deletionStart},${count} +${range.start},${count} @@\n`,
    // Context occupies one row per line on both surfaces, so the two counts
    // agree here even though they differ for any hunk holding a change.
    splitLineCount: count,
    splitLineStart: (prev ? prev.splitLineStart + prev.splitLineCount : 0) + collapsedBefore,
    unifiedLineCount: count,
    unifiedLineStart: (prev ? prev.unifiedLineStart + prev.unifiedLineCount : 0) + collapsedBefore,
    noEOFCRAdditions: false,
    noEOFCRDeletions: false,
  } as Hunk
}

/** Merge the anchors inside one gap into the island ranges to render for it. */
function islandsFor(gap: Gap, anchoredLines: readonly number[]): LineRange[] | null {
  if (gap.end - gap.start + 1 <= MIN_ISLANDED_GAP) return null
  const inGap = anchoredLines.filter((n) => n >= gap.start && n <= gap.end).sort((a, b) => a - b)
  if (inGap.length === 0) return null

  const merged: LineRange[] = []
  for (const line of inGap) {
    const start = Math.max(gap.start, line - ISLAND_RADIUS)
    const end = Math.min(gap.end, line + ISLAND_RADIUS)
    const last = merged[merged.length - 1]
    // Touching counts as overlapping: a one-line collapsed region between two
    // islands is worse than the row it hides.
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end)
    else merged.push({ start, end })
  }
  // Islands that swallowed the whole gap leave nothing collapsed on either
  // side, so there is no longer anything to be gained over just revealing it.
  if (merged.length === 1 && merged[0].start === gap.start && merged[0].end === gap.end) {
    return null
  }
  return merged
}

/**
 * Whether islanding, rather than the reveal path, is responsible for making
 * this new-file line visible.
 *
 * The two mechanisms have to agree on who owns which line or they fight. A
 * comment arriving mid-session updates the item's annotations before the
 * islanded `fileDiff` reaches it, so the reveal in `handlePostRender` would
 * see the line still stranded in the original gap and expand from the hunk
 * edge — and a Pierre expansion is permanent on the instance, so the island
 * that lands a moment later cannot undo it. The session then drifts away from
 * the layout a reload produces. Deferring on the gaps islanding will take
 * keeps that from ever starting.
 */
export function islandOwnsLine(fileDiff: FileDiffMetadata, line: number): boolean {
  if (fileDiff.isPartial || fileDiff.hunks.length === 0) return false
  return gapsOf(fileDiff).some(
    (gap) => line >= gap.start && line <= gap.end && gap.end - gap.start + 1 > MIN_ISLANDED_GAP,
  )
}

/**
 * A copy of `fileDiff` with a context-only hunk around each anchored new-file
 * line that would otherwise be stranded in a long collapsed region. Returns the
 * original object when nothing needs islanding, so callers can use identity to
 * decide whether anything changed.
 */
export function spliceCommentIslands(
  fileDiff: FileDiffMetadata,
  anchoredLines: readonly number[],
): FileDiffMetadata {
  // A partial diff has no full-file content behind the gaps, so there is
  // nothing to render in an island even if we invented one.
  if (fileDiff.isPartial || fileDiff.hunks.length === 0 || anchoredLines.length === 0) {
    return fileDiff
  }

  const islandsByGap = new Map<number, LineRange[]>()
  const deltaByGap = new Map<number, number>()
  for (const gap of gapsOf(fileDiff)) {
    const islands = islandsFor(gap, anchoredLines)
    if (!islands) continue
    islandsByGap.set(gap.before, islands)
    deltaByGap.set(gap.before, gap.delta)
  }
  if (islandsByGap.size === 0) return fileDiff

  const hunks: Hunk[] = []
  const emitIslands = (index: number) => {
    const ranges = islandsByGap.get(index)
    if (!ranges) return
    const delta = deltaByGap.get(index) ?? 0
    for (const range of ranges) hunks.push(islandHunk(range, delta, hunks[hunks.length - 1]))
  }

  fileDiff.hunks.forEach((hunk, index) => {
    emitIslands(index)
    const prev = hunks[hunks.length - 1]
    hunks.push(
      islandsByGap.has(index) && prev
        ? // Only the boundary moved: what the island rendered is exactly what
          // this hunk no longer has to hide, so its start positions still hold.
          { ...hunk, collapsedBefore: hunk.additionStart - (prev.additionStart + prev.additionCount) }
        : hunk,
    )
  })
  emitIslands(fileDiff.hunks.length)

  const signature = [...islandsByGap.values()]
    .flat()
    .map((r) => `${r.start}-${r.end}`)
    .join(',')
  return {
    ...fileDiff,
    hunks,
    // Pierre keys its highlight cache on this and the row layout just changed;
    // reusing the key would serve the un-islanded render from the same slot.
    cacheKey: `${fileDiff.cacheKey ?? fileDiff.name}#islands:${signature}`,
  }
}
