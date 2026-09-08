import type { ReviewComment } from '../../types'

/**
 * The files a comment is anchored to that the surface is not rendering.
 *
 * The ordinary way to reach a comment is to click it in the tracker and let
 * the viewer scroll to its annotation — which needs the file to be on the
 * surface. It often isn't: the agent answering a review rewrites the files it
 * was asked about, and a file that ends up matching HEAD leaves the diff
 * entirely, taking its comments' only rendering with it. The reply is stored
 * and the comment is listed, but nothing on screen can show either. Files
 * withheld for a long line (longLines.ts) strand their comments the same way,
 * which is why this asks what is *rendered* rather than what is in the diff.
 */
export function orphanCommentPaths(
  comments: ReviewComment[],
  renderedPaths: ReadonlySet<string>,
): Set<string> {
  const orphans = new Set<string>()
  for (const c of comments) {
    if (!renderedPaths.has(c.filePath)) orphans.add(c.filePath)
  }
  return orphans
}
