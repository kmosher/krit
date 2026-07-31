import type { FileDiffMetadata } from '@pierre/diffs'

/**
 * The mode change a file header should announce, or null if there is nothing
 * to say.
 *
 * A `chmod +x` is the one change git can report with no hunks at all: the
 * patch is three lines of metadata and no body. Without this the file appears
 * in the review with a "modified" pill, no `+N −N` (both counts are zero, so
 * both are suppressed), and an empty diff — on screen, nothing whatsoever
 * explaining why it is there.
 *
 * Read `prevMode`, not `mode`. Pierre sets `mode` from three separate places
 * (`parsePatchFiles`): the `new mode` line, the `new file mode` /
 * `deleted file mode` lines, and — the one that catches people — the `index`
 * line, which every ordinary modified file carries. So `mode` being present
 * says nothing at all; only `prevMode` marks a mode change, since git emits
 * `old mode` for nothing else.
 *
 * The equality check is belt-and-braces rather than a case git produces: git
 * writes the pair only when the two differ, so no fixture reaches it and
 * removing it breaks no test against real patch output. It is kept because
 * this reads whatever the server passed through, and a `100644 → 100644` row
 * would be a confusing thing to render on the strength of an assumption about
 * a patch we did not generate.
 *
 * A rename *with* a mode change does get a row, which is right — the file
 * header states the rename separately, and the mode is the part it omits.
 */
export function modeChangeOf(
  file: Pick<FileDiffMetadata, 'mode' | 'prevMode'>,
): { from: string; to: string } | null {
  const { mode, prevMode } = file
  if (!mode || !prevMode || mode === prevMode) return null
  return { from: prevMode, to: mode }
}
