// The two things every preview-renderer test does: find a rendered text node,
// and check that the anchor a selection over it produces slices the same text
// back out of the file.
//
// Shared because that round trip *is* the contract each renderer is being
// tested against — four open-coded copies made it look like four different
// claims. Test-only; not imported by anything under `components/` or by the
// renderers themselves.

import { buildLineIndex, lineColToOffset, previewRangeToAnchor } from './previewAnchor'
import type { SelectionAnchor } from './selectionMapping'

/** The first text node under `root` whose value is exactly `value`. */
export function textNode(root: Node, value: string): Text {
  const walk = (n: Node): Text | null => {
    if (n.nodeType === 3 && n.nodeValue === value) return n as Text
    for (let c = n.firstChild; c; c = c.nextSibling) {
      const hit = walk(c)
      if (hit) return hit
    }
    return null
  }
  const found = walk(root)
  if (!found) throw new Error(`no text node ${JSON.stringify(value)}`)
  return found
}

/** The file text an anchor's line/column range points at. */
export function sliceForAnchor(source: string, anchor: SelectionAnchor): string {
  const starts = buildLineIndex(source)
  return source.slice(
    lineColToOffset(starts, anchor.startLine, anchor.startColumn),
    lineColToOffset(starts, anchor.endLine, anchor.endColumn),
  )
}

/**
 * Selects a range within one rendered text node and resolves it, returning
 * both the anchor and the source it points at — a renderer is correct when
 * those two agree.
 */
export function anchorForSelection(
  root: Element,
  node: Text,
  from: number,
  to: number,
  source: string,
): { anchor: SelectionAnchor; slice: string } {
  const range = document.createRange()
  range.setStart(node, from)
  range.setEnd(node, to)
  const anchor = previewRangeToAnchor(range, root, source, buildLineIndex(source))
  if (!anchor) throw new Error('selection produced no anchor')
  return { anchor, slice: sliceForAnchor(source, anchor) }
}
