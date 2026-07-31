import { useEffect, useId, useRef, useState } from 'react'
import { parseXml } from '../utils/xmlPositions'
import { buildSvgDom, isSvgRoot } from '../utils/svgSanitize'

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
  // Distinguishes two panes from each other; the span distinguishes two
  // diagrams within one document. Both are needed — two whole-file diagrams
  // have the same span (`0..length`) whenever the files are the same length,
  // and Mermaid keys its gradient and marker defs on this id, so a collision
  // makes the second to mount silently repaint the first.
  const instanceId = useId().replace(/:/g, '')

  useEffect(() => {
    let cancelled = false
    setError(null)
    const host = hostRef.current
    if (!host) return
    const id = `krit-diagram-${instanceId}-${span.start}-${span.end}`
    render(source, id)
      .then((markup) => {
        if (cancelled) return
        const tree = parseXml(markup)
        if (!isSvgRoot(tree)) {
          setError(`${label} produced output krit could not read as SVG.`)
          return
        }
        const { root } = buildSvgDom(tree, host.ownerDocument, {
          stampOffsets: false,
          // The engine's own stylesheet, scoped to the id above — not markup
          // from the file under review, which is why a `.svg` file's is not
          // allowed through the same call.
          allowStylesheets: true,
        })
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
  }, [source, span.start, span.end, render, label, instanceId])

  // One tree for both states, because the canvas must keep its ref even while
  // the error is showing: rendering an error-only branch leaves `hostRef`
  // null, the next effect run returns at the host lookup before it can clear
  // the error, and the diagram never comes back. Fixing a syntax error and
  // saving — the loop live refresh exists for — is exactly when that bites.
  return (
    <div
      className={`diagram-preview ${className ?? ''}`}
      data-src={`${span.start}-${span.end}`}
      data-changed={changed ? 'true' : undefined}
    >
      {/* The source, not an apology: a diagram that won't draw is usually a
          diagram with a syntax error, and the reader still needs to comment on
          the line that has it. */}
      {error && (
        <>
          <p className="diagram-preview-error">{error}</p>
          <pre>{source}</pre>
        </>
      )}
      <div className="diagram-preview-canvas" ref={hostRef} hidden={error != null} />
    </div>
  )
}
