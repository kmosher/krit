import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MarkdownPreview } from './MarkdownPreview'
import { previewRangeToAnchor, readSpan } from '../utils/previewAnchor'

// The unit tests for previewAnchor hand-build the DOM they map over. These
// check the other half of that contract: that the real renderer stamps spans
// of the shape the mapper reads, and that a selection over genuinely rendered
// output lands on the right source text.

function firstText(root: Node, value: string): Text {
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

describe('MarkdownPreview', () => {
  it('stamps every element with source offsets that slice back to its source', () => {
    const source = '# Title\n\nPara with **bold** text.\n'
    const { container } = render(<MarkdownPreview source={source} changedRanges={[]} />)

    const h1 = container.querySelector('h1')!
    const strong = container.querySelector('strong')!
    expect(source.slice(...spanOf(h1))).toBe('# Title')
    expect(source.slice(...spanOf(strong))).toBe('**bold**')
  })

  it('maps a selection over rendered output back to the source text', () => {
    const source = '# Title\n\nPara with **bold** text.\n'
    const { container } = render(<MarkdownPreview source={source} changedRanges={[]} />)
    const root = container.querySelector('.markdown-preview-body')!

    const bold = firstText(root, 'bold')
    const range = document.createRange()
    range.setStart(bold, 0)
    range.setEnd(bold, 4)

    const anchor = previewRangeToAnchor(range, root, source)!
    expect(anchor.selectedText).toBe('bold')
    // Line 3 is the paragraph; `bold` starts after `Para with **`.
    expect(anchor.startLine).toBe(3)
    expect(source.split('\n')[2].slice(anchor.startColumn, anchor.endColumn)).toBe('bold')
  })

  it('marks blocks overlapping changed lines and leaves the rest alone', () => {
    const source = '# Title\n\nUntouched paragraph.\n\nEdited paragraph.\n'
    // Line 5 is the second paragraph.
    const { container } = render(<MarkdownPreview source={source} changedRanges={[[5, 5]]} />)
    const paragraphs = Array.from(container.querySelectorAll('p'))
    expect(paragraphs.map((p) => p.hasAttribute('data-changed'))).toEqual([false, true])
    expect(container.querySelector('h1')!.hasAttribute('data-changed')).toBe(false)
  })

  it('renders the raw HTML agent-written docs actually use', () => {
    const source = '<details><summary>More</summary>\n\nHidden body.\n\n</details>\n'
    const { container } = render(<MarkdownPreview source={source} changedRanges={[]} />)
    expect(container.querySelector('details')).not.toBeNull()
    expect(container.querySelector('summary')?.textContent).toBe('More')
  })

  it('strips scripts and event handlers from raw HTML in the document', () => {
    const source = [
      'Text before.',
      '',
      '<script>window.__pwned = true</script>',
      '<img src="x" onerror="window.__pwned = true">',
      '<a href="javascript:window.__pwned = true">link</a>',
      '',
      'Text after.',
    ].join('\n')
    const { container } = render(<MarkdownPreview source={source} changedRanges={[]} />)

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    const link = container.querySelector('a')
    // rehype-sanitize drops the attribute rather than rewriting the element.
    expect(link?.getAttribute('href') ?? '').not.toContain('javascript:')
    expect(container.textContent).toContain('Text after.')
  })

  it('keeps stamps on elements recovered from raw HTML', () => {
    const source = 'Before.\n\n<div class="note">Inside a raw block.</div>\n'
    const { container } = render(<MarkdownPreview source={source} changedRanges={[]} />)
    const div = container.querySelector('div.note')!
    expect(source.slice(...spanOf(div))).toContain('Inside a raw block.')
  })

  it('handles GFM tables, which are a common shape in generated docs', () => {
    const source = '| a | b |\n|---|---|\n| 1 | 2 |\n'
    const { container } = render(<MarkdownPreview source={source} changedRanges={[]} />)
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelectorAll('td')).toHaveLength(2)
    for (const cell of container.querySelectorAll('td')) {
      expect(readSpan(cell)).not.toBeNull()
    }
  })
})

function spanOf(el: Element): [number, number] {
  const span = readSpan(el)
  if (!span) throw new Error(`${el.tagName} carries no data-src`)
  return [span.start, span.end]
}
