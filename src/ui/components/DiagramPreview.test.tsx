import { describe, it, expect } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { DiagramPreview } from './DiagramPreview'
import { buildLineIndex, previewRangeToAnchor } from '../utils/previewAnchor'
import { anchorForSelection, textNode } from '../utils/previewTestHelpers'

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
    const { anchor, slice } = anchorForSelection(
      root,
      textNode(root, 'Worker pool'),
      0,
      11,
      SOURCE,
    )
    expect(slice).toBe('Worker pool')
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
    const { anchor } = anchorForSelection(root, textNode(root, 'Worker pool'), 0, 11, SOURCE)
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
    // The wrapper carries the span in both states, so the shown source is
    // still anchorable — a reviewer can comment on the line that failed.
    expect(pre.closest('[data-src]')!.getAttribute('data-src')).toBe(`0-${SOURCE.length}`)
  })

  it('draws again once the source that failed is fixed', async () => {
    // The error branch used to render without the canvas, so hostRef went null
    // and every later effect run bailed before it could clear the error — the
    // diagram never returned for the life of the mount, which is precisely the
    // save-and-retry loop live refresh exists for.
    const failing = () => Promise.reject(new Error('Parse error on line 2'))
    const { container, rerender } = render(
      <DiagramPreview
        source={SOURCE}
        span={{ start: 0, end: SOURCE.length }}
        render={failing}
        label="Mermaid"
      />,
    )
    await waitFor(() => expect(container.querySelector('.diagram-preview-error')).not.toBeNull())

    const fixed = `${SOURCE}  C --> D\n`
    rerender(
      <DiagramPreview
        source={fixed}
        span={{ start: 0, end: fixed.length }}
        render={drawn(LABELS_SVG)}
        label="Mermaid"
      />,
    )
    await waitFor(() => expect(container.querySelector('text')).not.toBeNull())
    expect(container.querySelector('.diagram-preview-error')).toBeNull()
  })

  it('gives two diagrams of the same length different ids', async () => {
    // Mermaid keys its gradient and marker defs on the id, so a collision has
    // the second mount silently repaint the first.
    const seen: string[] = []
    const capture = (_src: string, id: string) => {
      seen.push(id)
      return Promise.resolve(LABELS_SVG)
    }
    const props = { source: SOURCE, span: { start: 0, end: SOURCE.length }, label: 'Mermaid' }
    render(
      <>
        <DiagramPreview {...props} render={capture} />
        <DiagramPreview {...props} render={capture} />
      </>,
    )
    await waitFor(() => expect(seen.length).toBe(2))
    expect(seen[0]).not.toBe(seen[1])
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
