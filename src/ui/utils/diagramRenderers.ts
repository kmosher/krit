// Lazy loaders for the two diagram engines.
//
// Both are large — Mermaid is about a quarter of the bundle on its own, and
// Graphviz ships a wasm module — and most reviews never open a diagram. They
// are therefore behind `import()` and resolved on first use, which puts each
// in its own chunk. `PreviewPane` is already lazy; this is a second tier
// inside it, so previewing a Markdown file with no diagrams in it costs
// neither engine.

import type { DiagramRenderer } from '../components/DiagramPreview'

let mermaidReady: Promise<typeof import('mermaid').default> | null = null

function loadMermaid() {
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // Blocks the `%%{init}%%` directive and sanitizes label text. A diagram
      // in a file under review is untrusted input like any other.
      securityLevel: 'strict',
      // Labels must be SVG `<text>`, not `<foreignObject>`: the allowlist
      // drops foreignObject (it is arbitrary HTML), so HTML labels would
      // render as a diagram with every caption missing.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      class: { htmlLabels: false },
    })
    return mermaid
  })
  return mermaidReady
}

export const renderMermaid: DiagramRenderer = async (source, id) => {
  const mermaid = await loadMermaid()
  const { svg } = await mermaid.render(id, source)
  return svg
}

let vizReady: Promise<{ renderString: (src: string, opts?: object) => string }> | null = null

export const renderGraphviz: DiagramRenderer = async (source) => {
  vizReady ??= import('@viz-js/viz').then((m) => m.instance())
  const viz = await vizReady
  return viz.renderString(source, { format: 'svg' })
}
