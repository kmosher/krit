import { describe, it, expect } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { DiagramPreview } from './DiagramPreview'
import { buildLineIndex, lineColToOffset, previewRangeToAnchor } from '../utils/previewAnchor'

// Mermaid and Graphviz both need real layout to draw, so neither engine runs
// here. What these cover is the part that is ours: the wrapper's stamp, the
// allowlist the rendered SVG goes through, and the failure path — and, most
// of all, that a label selected in the picture anchors to the line of diagram
// source that declared it.

const SOURCE = `graph TD
  A[Ingest queue] --> B[Worker pool]
  B --> C[Object store]
`

const drawn = (svg: string) => () => Promise.resolve(svg)

const LABELS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg">' +
  '<g><text>Ingest queue</text></g>' +
  '<g><text>Worker pool</text></g>' +
  '</svg>'

function textNode(root: Node, value: string): Text {
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

describe('DiagramPreview', () => {
  it('anchors a label selected in the picture to the line that declared it', async () => {
    const { container } = render(
      <DiagramPreview
        source={SOURCE}
        span={{ start: 0, end: SOURCE.length }}
        render={drawn(LABELS_SVG)}
        label="Mermaid"
      />,
    )
    await waitFor(() => expect(container.querySelector('text')).not.toBeNull())

    const root = container.querySelector('.diagram-preview')!
    const node = textNode(root, 'Worker pool')
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 11)
    const anchor = previewRangeToAnchor(range, root, SOURCE, buildLineIndex(SOURCE))!
    const starts = buildLineIndex(SOURCE)
    expect(
      SOURCE.slice(
        lineColToOffset(starts, anchor.startLine, anchor.startColumn),
        lineColToOffset(starts, anchor.endLine, anchor.endColumn),
      ),
    ).toBe('Worker pool')
    expect(anchor.startLine).toBe(2)
  })

  it('anchors exactly even though the engine emitted a stylesheet bigger than the file', async () => {
    // Mermaid really does this: ~5 kB of generated CSS inside the element the
    // diagram is stamped with. Counted as rendered text it puts the search
    // floor past the end of the source, and every label then snaps to the
    // whole file — an anchor that looks plausible and is wrong.
    const withStyle =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>' +
      '.node{fill:#eee}'.repeat(400) +
      '</style><g><text>Worker pool</text></g></svg>'
    const { container } = render(
      <DiagramPreview
        source={SOURCE}
        span={{ start: 0, end: SOURCE.length }}
        render={drawn(withStyle)}
        label="Mermaid"
      />,
    )
    await waitFor(() => expect(container.querySelector('text')).not.toBeNull())

    const root = container.querySelector('.diagram-preview')!
    const node = textNode(root, 'Worker pool')
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 11)
    const anchor = previewRangeToAnchor(range, root, SOURCE, buildLineIndex(SOURCE))!
    expect(anchor.startLine).toBe(2)
    expect(anchor.endLine).toBe(2)
  })

  it('widens to the whole diagram when the label was not written that way', async () => {
    const rewrapped = '<svg xmlns="http://www.w3.org/2000/svg"><text>Ingest\nqueue</text></svg>'
    const { container } = render(
      <DiagramPreview
        source={SOURCE}
        span={{ start: 0, end: SOURCE.length }}
        render={drawn(rewrapped)}
        label="Mermaid"
      />,
    )
    await waitFor(() => expect(container.querySelector('text')).not.toBeNull())

    const root = container.querySelector('.diagram-preview')!
    const node = textNode(root, 'Ingest\nqueue')
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 12)
    const anchor = previewRangeToAnchor(range, root, SOURCE, buildLineIndex(SOURCE))!
    // A superset of what was highlighted, which is always safe to act on.
    expect(anchor.startLine).toBe(1)
    expect(anchor.endLine).toBe(buildLineIndex(SOURCE).length)
  })

  it('puts the rendered SVG through the same allowlist a .svg file gets', async () => {
    const hostile =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><text>ok</text></svg>'
    const { container } = render(
      <DiagramPreview
        source={SOURCE}
        span={{ start: 0, end: SOURCE.length }}
        render={drawn(hostile)}
        label="Mermaid"
      />,
    )
    await waitFor(() => expect(container.querySelector('text')).not.toBeNull())
    expect(container.querySelector('script')).toBeNull()
  })

  it('shows the source when the engine refuses it, because that is what needs commenting', async () => {
    const { container } = render(
      <DiagramPreview
        source={SOURCE}
        span={{ start: 0, end: SOURCE.length }}
        render={() => Promise.reject(new Error('Parse error on line 2'))}
        label="Mermaid"
      />,
    )
    await waitFor(() =>
      expect(container.querySelector('.diagram-preview-error')!.textContent).toContain(
        'Parse error on line 2',
      ),
    )
    const pre = container.querySelector('pre')!
    expect(pre.textContent).toBe(SOURCE)
    expect(pre.getAttribute('data-src')).toBe(`0-${SOURCE.length}`)
  })

  it('reports output it cannot read rather than rendering an empty box', async () => {
    const { container } = render(
      <DiagramPreview
        source={SOURCE}
        span={{ start: 0, end: SOURCE.length }}
        render={drawn('not markup at all')}
        label="Graphviz"
      />,
    )
    await waitFor(() =>
      expect(container.querySelector('.diagram-preview-error')!.textContent).toContain('Graphviz'),
    )
  })
})
