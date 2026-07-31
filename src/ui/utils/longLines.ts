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
 * The number is well below where the damage was seen (4k rendered fine, 16k did
 * not) rather than just under it, because the failure scales with how many rows
 * the line wraps to — which grows as the window narrows. A cap tuned to a wide
 * window would come back on a split screen.
 */
export const MAX_RENDERABLE_LINE = 2000

/**
 * The longest line on either side, counting context: Pierre renders unchanged
 * lines too once a collapsed region is expanded, and the reserved height is
 * computed from what it renders.
 */
export function longestLineIn(fileDiff: FileDiffMetadata): number {
  let longest = 0
  for (const line of fileDiff.additionLines) {
    if (line.length > longest) longest = line.length
  }
  for (const line of fileDiff.deletionLines) {
    if (line.length > longest) longest = line.length
  }
  return longest
}

export function isTooWideToRender(fileDiff: FileDiffMetadata): boolean {
  return longestLineIn(fileDiff) > MAX_RENDERABLE_LINE
}
