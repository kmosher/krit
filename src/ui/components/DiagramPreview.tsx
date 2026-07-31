import { useEffect, useRef, useState } from 'react'
import { parseXml } from '../utils/xmlPositions'
import { buildSvgDom, isSvgRoot } from '../utils/svgPreview'

// A diagram rendered from text — Mermaid, Graphviz — as a commentable surface.
//
// Anchoring here is the quote tier of the ladder rather than the position
// tier, and it costs no new code to get it. The picture is wrapped in one
// element stamped with the diagram source's own span, so when a reader selects
// a node label, `previewAnchor`'s locate-by-value rule searches that slice for
// the label's text and finds the line that declared it. A label that doesn't
// occur verbatim in the source — Mermaid rewraps long ones — snaps outward to
// the whole diagram, which is a superset and therefore safe.
//
// Both renderers' output goes through the same allowlist an `.svg` file does,
// so no markup string is ever handed to `innerHTML` on any preview path.

export type DiagramRenderer = (source: string, id: string) => Promise<string>

interface Props {
  source: string
  /** File offsets of the diagram source, for the wrapper's stamp. */
  span: { start: number; end: number }
  changed?: boolean
  render: DiagramRenderer
  /** Names the failure in the error strip: "Mermaid", "Graphviz". */
  label: string
  className?: string
}

export function DiagramPreview({ source, span, changed, render, label, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return
    setError(null)
    // The id has to be unique per render: Mermaid keys internal defs on it, so
    // two diagrams sharing one id share gradient and marker definitions, and
    // the second to mount silently repaints the first.
    const id = `krit-diagram-${span.start}-${span.end}`
    render(source, id)
      .then((markup) => {
        if (cancelled) return
        const tree = parseXml(markup)
        if (!isSvgRoot(tree)) {
          setError(`${label} produced output krit could not read as SVG.`)
          return
        }
        const { root } = buildSvgDom(tree, host.ownerDocument, { stampOffsets: false })
        host.replaceChildren()
        if (root) host.appendChild(root)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : `${label} could not draw this.`)
      })
    return () => {
      cancelled = true
      host.replaceChildren()
    }
  }, [source, span.start, span.end, render, label])

  if (error) {
    // The source, not an apology: a diagram that won't draw is usually a
    // diagram with a syntax error, and the reader still needs to comment on
    // the line that has it.
    return (
      <div className={`diagram-preview ${className ?? ''}`}>
        <p className="diagram-preview-error">{error}</p>
        <pre data-src={`${span.start}-${span.end}`} data-changed={changed ? 'true' : undefined}>
          {source}
        </pre>
      </div>
    )
  }

  return (
    <div
      className={`diagram-preview ${className ?? ''}`}
      data-src={`${span.start}-${span.end}`}
      data-changed={changed ? 'true' : undefined}
    >
      <div className="diagram-preview-canvas" ref={hostRef} />
    </div>
  )
}
