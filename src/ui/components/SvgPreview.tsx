import { useEffect, useMemo, useRef, useState } from 'react'
import { parseXml } from '../utils/xmlPositions'
import { buildSvgDom, isSvgRoot } from '../utils/svgSanitize'
import { buildLineIndex, offsetToLineCol, readSpan } from '../utils/previewAnchor'
import { rangesIntersect } from '../utils/previewFormat'

// The picture, rather than its markup. Text inside it anchors like text
// anywhere else in a preview, because `buildSvgDom` stamps `data-src` on every
// element it keeps.

interface Props {
  source: string
  changedRanges: Array<[number, number]>
}

export function SvgPreview({ source, changedRanges }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [removed, setRemoved] = useState<string[]>([])
  const parsed = useMemo(() => {
    const tree = parseXml(source)
    return isSvgRoot(tree) ? tree : null
  }, [source])

  // Built imperatively because this subtree is not React's: `createElementNS`
  // is what gets the SVG namespace and verbatim attribute names right, and
  // going through it element by element is also what keeps `innerHTML` — and
  // everything the allowlist exists to stop — off this path entirely.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !parsed) return
    const built = buildSvgDom(parsed, host.ownerDocument)
    host.replaceChildren()
    setRemoved([...new Set(built.removed)].sort())
    if (!built.root) return
    if (changedRanges.length > 0) markChanged(built.root, buildLineIndex(source), changedRanges)
    host.appendChild(built.root)
    return () => host.replaceChildren()
  }, [parsed, source, changedRanges])

  if (!parsed) {
    return (
      <div className="svg-preview-error">
        This file isn’t well-formed SVG, so there is nothing to draw. Close the preview to read its
        diff.
      </div>
    )
  }

  return (
    <div className="svg-preview-body">
      <div className="svg-preview-canvas" ref={hostRef} />
      {/* Worth saying out loud: a reviewer looking at a picture with no note
          has no way to tell a diagram that renders this way from one whose
          `<image>` or `<foreignObject>` silently did not come through. */}
      {removed.length > 0 && (
        <p className="svg-preview-removed">
          Not rendered, because it could run, fetch, or restyle this page:{' '}
          <code>{removed.join(', ')}</code>
        </p>
      )}
    </div>
  )
}

/**
 * Marks the innermost element the diff touched, in one post-order pass.
 *
 * Only the innermost: every ancestor up to `<svg>` spans the change too, and
 * outlining all of them outlines the whole picture. Bottom-up rather than
 * asking each node whether any descendant changed — that question re-walks the
 * subtree, which is quadratic on the machine-generated SVGs (tens of thousands
 * of paths) that are ordinary in a repo.
 *
 * Returns whether anything at or below `el` changed.
 */
function markChanged(
  el: Element,
  lineStarts: number[],
  ranges: Array<[number, number]>,
): boolean {
  let descendantChanged = false
  for (const child of Array.from(el.children)) {
    if (markChanged(child, lineStarts, ranges)) descendantChanged = true
  }
  const self = elementChanged(el, lineStarts, ranges)
  if (self && !descendantChanged) el.setAttribute('data-changed', 'true')
  return self || descendantChanged
}

function elementChanged(
  el: Element,
  lineStarts: number[],
  ranges: Array<[number, number]>,
): boolean {
  const span = readSpan(el)
  if (!span) return false
  const start = offsetToLineCol(lineStarts, span.start).line
  // `end` is exclusive, so step back into the last character's line.
  const end = offsetToLineCol(lineStarts, Math.max(span.start, span.end - 1)).line
  return rangesIntersect(ranges, start, end)
}
