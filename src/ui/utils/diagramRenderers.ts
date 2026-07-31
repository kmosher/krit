// Lazy loaders for the two diagram engines.
//
// Both are large — Mermaid is about a quarter of the bundle on its own, and
// Graphviz ships a wasm module — and most reviews never open a diagram. They
// are therefore behind `import()` and resolved on first use, which puts each
// in its own chunk. `PreviewPane` is already lazy; this is a second tier
// inside it, so previewing a Markdown file with no diagrams in it costs
// neither engine.

import type { DiagramRenderer } from '../components/DiagramPreview'

/**
 * Caches the loaded engine, but never a failure: a rejected promise left in
 * the cache makes one interrupted chunk fetch permanent for the tab, and every
 * later diagram fails with an import error the reviewer can do nothing about.
 */
function cache<T>(slot: { p: Promise<T> | null }, load: () => Promise<T>): Promise<T> {
  slot.p ??= load().catch((e: unknown) => {
    slot.p = null
    throw e
  })
  return slot.p
}

const mermaidSlot: { p: Promise<typeof import('mermaid').default> | null } = { p: null }

function loadMermaid() {
  return cache(mermaidSlot, () =>
    import('mermaid').then(({ default: mermaid }) => {
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
    }),
  )
}

export const renderMermaid: DiagramRenderer = async (source, id) => {
  const mermaid = await loadMermaid()
  const { svg } = await mermaid.render(id, source)
  return svg
}

const vizSlot: { p: Promise<{ renderString: (src: string, opts?: object) => string }> | null } = {
  p: null,
}

export const renderGraphviz: DiagramRenderer = async (source) => {
  const viz = await cache(vizSlot, () => import('@viz-js/viz').then((m) => m.instance()))
  return viz.renderString(source, { format: 'svg' })
}
