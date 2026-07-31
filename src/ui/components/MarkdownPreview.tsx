import { useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { visit } from 'unist-util-visit'
import type { Root } from 'hast'
import { rangesIntersect } from '../utils/previewFormat'

// Renders Markdown as a document, stamping every element with the source
// offsets it came from (`data-src`) so a selection over the result can be
// mapped back to the file — see previewAnchor.ts, which consumes the stamp,
// and docs/design/rendered-preview.md for why the stamp is the whole design.

export interface SourceOffsetOptions {
  changedRanges: Array<[number, number]>
  /**
   * Translates an offset into the rendered Markdown into an offset into the
   * *file*. The two differ only when the Markdown is embedded in something
   * else — a notebook cell, where the text is a JSON string literal and
   * escapes make the correspondence non-linear.
   */
  mapOffset?: (offset: number) => number
  /**
   * Overrides the line-range test when the caller already knows whether this
   * document changed. A notebook cell's Markdown has its own line numbering,
   * which the diff's new-side line numbers say nothing about.
   */
  changed?: boolean
}

/**
 * Stamps `data-src="<startOffset>-<endOffset>"` on every element, and
 * `data-changed` on those overlapping lines the diff touched.
 *
 * Runs after rehype-raw (so elements recovered from raw HTML in the markdown
 * are stamped too — it re-parses but preserves positions) and before
 * rehype-sanitize, which is what drops the attributes off anything the schema
 * doesn't recognise.
 */
export function rehypeSourceOffsets(options: SourceOffsetOptions) {
  const map = options.mapOffset ?? ((n: number) => n)
  return (tree: Root) => {
    visit(tree, 'element', (node) => {
      const p = node.position
      if (p?.start?.offset == null || p?.end?.offset == null) return
      node.properties = node.properties ?? {}
      node.properties.dataSrc = `${map(p.start.offset)}-${map(p.end.offset)}`
      const changed =
        options.changed ?? rangesIntersect(options.changedRanges, p.start.line, p.end.line)
      if (changed) node.properties.dataChanged = 'true'
    })
  }
}

// Permissive where agent-written docs actually live — `<details>`, `<kbd>`,
// `<sub>` and friends are common enough in generated documentation that
// stripping them would misrepresent the file — and closed everywhere it
// matters: rehype-sanitize's default schema already drops `<script>`,
// `<style>`, every `on*` handler and `javascript:` URLs, and nothing here
// re-admits them.
const SCHEMA = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'details',
    'summary',
    'kbd',
    'sub',
    'sup',
    'abbr',
    'mark',
  ],
  attributes: {
    ...defaultSchema.attributes,
    // hast property names, not HTML attribute names — `dataSrc` is what the
    // stamp above sets, and listing `data-src` here would silently drop it.
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'dataSrc', 'dataChanged', 'className'],
  },
}

interface Props {
  source: string
  /** Inclusive new-side line ranges the diff added or modified. */
  changedRanges: Array<[number, number]>
  /** See `SourceOffsetOptions` — set by the notebook path only. */
  mapOffset?: (offset: number) => number
  changed?: boolean
}

export function MarkdownPreview({ source, changedRanges, mapOffset, changed }: Props) {
  // Rebuilt only when the changed lines actually move: the plugin closes over
  // them, and a fresh array every render would reparse the document on every
  // keystroke in an open comment form.
  const key = changedRanges.map(([a, b]) => `${a}-${b}`).join(',')
  const rehypePlugins = useMemo(
    () => [
      rehypeRaw,
      [rehypeSourceOffsets, { changedRanges, mapOffset, changed }],
      [rehypeSanitize, SCHEMA],
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, mapOffset, changed],
  )

  return (
    <div className="markdown-preview-body">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins as never}>
        {source}
      </Markdown>
    </div>
  )
}
