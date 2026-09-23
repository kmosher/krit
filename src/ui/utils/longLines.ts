import type { FileDiffMetadata } from '@pierre/diffs'

/**
 * The longest line krit will hand to CodeView.
 *
 * A single very long line does not break the file it is in — it breaks the
 * whole surface. Pierre wraps such a line across thousands of screen rows, and
 * every other item on the surface is then positioned from a bad offset: at ~16k
 * characters the review renders roughly half a screen too low, and at ~56k it
 * is pushed off the viewport entirely and the pane looks blank. Nothing throws,
 * nothing logs, and the file list still lists every file — which is why this
 * reads as "krit is broken" rather than as one bad file.
 *
 * Where upstream gets it wrong is not established. The obvious suspect, the
 * virtualizer's height estimate for the wrapped run, is not it: the estimate is
 * corrected by `reconcileHeights` and the correction propagates, which
 * `virtualizedFileDiffWrappedLines.test.ts` in our pierre fork pins down. A
 * standalone CodeView (`apps/longline-repro` there) does not displace at all at
 * either length, so whatever triggers it needs more than a wrapped line. Treat
 * the numbers above as measurements of krit, not as a diagnosis.
 *
 * Minified bundles, generated lockfiles, single-line JSON and inlined data URIs
 * all reach this length in ordinary repos, so this is a papercut on real work
 * long before it is anything to do with hostile input.
 *
 * The number is below where the damage was seen (4k rendered fine, 16k did
 * not) rather than just under it, because the failure scales with how many rows
 * the line wraps to — which grows as the window narrows. A cap tuned to a wide
 * window would come back on a split screen.
 */
export const MAX_RENDERABLE_LINE = 4000

/**
 * The longest line the file's hunks will render, on either side. Only hunk
 * lines count: a file is not withheld for a line sitting in collapsed context,
 * because the Pulumi stack configs that motivated this carry 2k-character
 * `secure:` ciphertexts nobody changes and nobody expands to. The cost is that
 * expanding a gap across such a line can still displace the surface.
 *
 * Truncating gap lines in the copy handed to CodeView would close that, but
 * an inline edit session takes its text from the same `additionLines`, so
 * saving would write the truncated line to disk.
 *
 * Pass the islanded diff: a comment island is a hunk, and renders its lines.
 */
export function longestLineIn(fileDiff: FileDiffMetadata): number {
  let longest = 0
  for (const hunk of fileDiff.hunks) {
    longest = Math.max(
      longest,
      longestIn(fileDiff.additionLines, hunk.additionLineIndex, hunk.additionCount),
      longestIn(fileDiff.deletionLines, hunk.deletionLineIndex, hunk.deletionCount),
    )
  }
  return longest
}

function longestIn(lines: string[], start: number, count: number): number {
  let longest = 0
  for (let i = start; i < start + count && i < lines.length; i++) {
    if (lines[i].length > longest) longest = lines[i].length
  }
  return longest
}

export function isTooWideToRender(fileDiff: FileDiffMetadata): boolean {
  return longestLineIn(fileDiff) > MAX_RENDERABLE_LINE
}
