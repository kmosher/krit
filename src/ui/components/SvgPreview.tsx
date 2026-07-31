import { useEffect, useMemo, useRef, useState } from 'react'
import { parseXml } from '../utils/xmlPositions'
import { buildSvgDom, isSvgRoot } from '../utils/svgPreview'
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
    markChanged(built.root, buildLineIndex(source), changedRanges)
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
          Not rendered, because it can run or fetch: <code>{removed.join(', ')}</code>
        </p>
      )}
    </div>
  )
}

function markChanged(root: Element, lineStarts: number[], ranges: Array<[number, number]>) {
  if (ranges.length === 0) return
  const visit = (el: Element) => {
    const span = readSpan(el)
    if (span) {
      const start = offsetToLineCol(lineStarts, span.start).line
      const end = offsetToLineCol(lineStarts, Math.max(span.start, span.end - 1)).line
      // Only the innermost changed element is marked: every ancestor up to
      // `<svg>` spans the change too, and outlining all of them outlines the
      // whole picture.
      if (rangesIntersect(ranges, start, end) && !hasChangedDescendant(el, lineStarts, ranges)) {
        el.setAttribute('data-changed', 'true')
      }
    }
    for (const child of Array.from(el.children)) visit(child)
  }
  visit(root)
}

function hasChangedDescendant(
  el: Element,
  lineStarts: number[],
  ranges: Array<[number, number]>,
): boolean {
  for (const child of Array.from(el.children)) {
    const span = readSpan(child)
    if (span) {
      const start = offsetToLineCol(lineStarts, span.start).line
      const end = offsetToLineCol(lineStarts, Math.max(span.start, span.end - 1)).line
      if (rangesIntersect(ranges, start, end)) return true
    }
    if (hasChangedDescendant(child, lineStarts, ranges)) return true
  }
  return false
}
