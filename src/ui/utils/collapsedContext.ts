import type { AnnotationSide, FileDiffMetadata } from '@pierre/diffs'

// Pierre hides the unchanged stretches between hunks behind an expander, and
// it draws no annotation for a line it did not render — so a comment anchored
// inside one is invisible, with nothing on screen to say it exists. The cure
// is `FileDiff.revealLine`, but every renderable/reveal API upstream is keyed
// on *new-file* line numbers, while a krit comment carries the line number of
// whichever side it was made on.

/**
 * The new-file line Pierre needs in order to reveal this anchor, or null when
 * there is nothing to reveal — a file-level anchor (`lineNumber: 0`) is not a
 * line, a line inside a hunk always has a row, and a file with no hunks (the
 * emptied body behind a rendered preview) has no collapsed regions at all.
 */
export function additionLineForAnchor(
  fileDiff: Pick<FileDiffMetadata, 'hunks'>,
  side: AnnotationSide,
  lineNumber: number,
): number | null {
  const hunks = fileDiff.hunks
  if (lineNumber <= 0 || !hunks || hunks.length === 0) return null
  if (side === 'additions') return lineNumber
  for (const hunk of hunks) {
    // The gap ahead of this hunk is unchanged by definition, so it shifts by
    // exactly the offset the hunk header declares.
    if (lineNumber < hunk.deletionStart) {
      return lineNumber + (hunk.additionStart - hunk.deletionStart)
    }
    if (lineNumber < hunk.deletionStart + hunk.deletionCount) return null
  }
  // Past every hunk: the trailing region carries the file's whole delta.
  const last = hunks[hunks.length - 1]
  const delta =
    last.additionStart + last.additionCount - (last.deletionStart + last.deletionCount)
  return lineNumber + delta
}

/** Every new-file line that has to render for this file's anchors to be seen. */
export function linesToReveal(
  fileDiff: Pick<FileDiffMetadata, 'hunks'>,
  annotations: ReadonlyArray<{ side: AnnotationSide; lineNumber: number }>,
): number[] {
  const lines = new Set<number>()
  for (const annotation of annotations) {
    const line = additionLineForAnchor(fileDiff, annotation.side, annotation.lineNumber)
    if (line != null) lines.add(line)
  }
  return [...lines]
}
