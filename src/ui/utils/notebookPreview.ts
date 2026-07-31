// A Jupyter notebook read as cells rather than as the JSON it is stored in.
//
// The whole point is anchoring: a comment on rendered cell content has to land
// on a character range in the *file*, which is JSON. So every cell carries an
// offset map from its decoded text back into the file, and the renderer
// composes that with the offsets it stamps (see `NotebookPreview`, and
// `rehypeSourceOffsets`'s `mapOffset` for the Markdown half).

import { buildLineIndex, offsetToLineCol } from './previewAnchor'
import { objectField, parseJsonWithPositions, stringValue, type JsonNode } from './jsonPositions'

export interface MappedText {
  text: string
  /** `map[i]` is the file offset of decoded character `i`; length is `text.length + 1`. */
  map: number[]
  /** File span of the JSON value the text was decoded from, for an outward snap. */
  start: number
  end: number
}

export type NotebookOutput =
  | { kind: 'text'; text: string; stream?: string }
  | { kind: 'image'; mime: string; data: string }
  | { kind: 'error'; text: string }

export interface NotebookCell {
  index: number
  type: 'markdown' | 'code' | 'raw'
  source: MappedText
  /** 1-based file lines the cell's source occupies, for changed-block marking. */
  startLine: number
  endLine: number
  executionCount: number | null
  outputs: NotebookOutput[]
}

export interface Notebook {
  cells: NotebookCell[]
  /** Language of code cells, for syntax hinting; null when the file omits it. */
  language: string | null
}

/** Null for anything that isn't a parseable notebook — the caller says so. */
export function parseNotebook(source: string): Notebook | null {
  const root = parseJsonWithPositions(source)
  if (!root || root.kind !== 'object') return null
  const cellsNode = objectField(root, 'cells')
  if (cellsNode?.kind !== 'array') return null

  const lineStarts = buildLineIndex(source)
  const language =
    stringValue(objectField(objectField(objectField(root, 'metadata'), 'kernelspec'), 'language')) ??
    stringValue(
      objectField(objectField(objectField(root, 'metadata'), 'language_info'), 'name'),
    )

  const cells: NotebookCell[] = []
  cellsNode.items.forEach((cellNode, index) => {
    if (cellNode.kind !== 'object') return
    const rawType = stringValue(objectField(cellNode, 'cell_type'))
    const type = rawType === 'markdown' || rawType === 'raw' ? rawType : 'code'
    const text = readMappedText(objectField(cellNode, 'source'))
    if (!text) return
    const execNode = objectField(cellNode, 'execution_count')
    cells.push({
      index,
      type,
      source: text,
      startLine: offsetToLineCol(lineStarts, text.start).line,
      endLine: offsetToLineCol(lineStarts, Math.max(text.start, text.end - 1)).line,
      executionCount: execNode?.kind === 'number' ? execNode.value : null,
      outputs: readOutputs(objectField(cellNode, 'outputs')),
    })
  })
  return { cells, language }
}

/**
 * A `source`-shaped value — nbformat allows either one string or an array of
 * them, each usually ending in its own newline — as one decoded string with a
 * per-character map back into the file.
 */
export function readMappedText(node: JsonNode | undefined): MappedText | null {
  if (!node) return null
  if (node.kind === 'string') {
    return { text: node.value, map: node.map.slice(), start: node.start, end: node.end }
  }
  if (node.kind !== 'array') return null
  let text = ''
  const map: number[] = []
  for (const item of node.items) {
    if (item.kind !== 'string') continue
    text += item.value
    // Drop each part's trailing entry as we go; the last one supplies the
    // final past-the-end position below.
    for (let i = 0; i < item.value.length; i++) map.push(item.map[i])
  }
  const last = node.items[node.items.length - 1]
  map.push(last?.kind === 'string' ? last.map[last.value.length] : node.end)
  return { text, map, start: node.start, end: node.end }
}

/**
 * A decoded-text offset as a file offset. Offsets past the end clamp to the
 * value's own end, so an exclusive range endpoint stays inside the cell.
 */
export function toFileOffset(mapped: MappedText, offset: number): number {
  if (offset <= 0) return mapped.map[0] ?? mapped.start
  if (offset >= mapped.map.length) return mapped.end
  return mapped.map[offset]
}

function readOutputs(node: JsonNode | undefined): NotebookOutput[] {
  if (node?.kind !== 'array') return []
  const outputs: NotebookOutput[] = []
  for (const out of node.items) {
    if (out.kind !== 'object') continue
    const kind = stringValue(objectField(out, 'output_type'))
    if (kind === 'stream') {
      const text = readMappedText(objectField(out, 'text'))
      if (text) outputs.push({ kind: 'text', text: text.text, stream: stringValue(objectField(out, 'name')) ?? undefined })
      continue
    }
    if (kind === 'error') {
      const tb = objectField(out, 'traceback')
      const text = tb?.kind === 'array' ? tb.items.map((t) => stringValue(t) ?? '').join('\n') : null
      outputs.push({
        kind: 'error',
        text:
          text ??
          [stringValue(objectField(out, 'ename')), stringValue(objectField(out, 'evalue'))]
            .filter(Boolean)
            .join(': '),
      })
      continue
    }
    const data = objectField(out, 'data')
    if (data?.kind !== 'object') continue
    // Richest renderable form first, then the plain-text fallback every kernel
    // is supposed to emit alongside it. Deliberately no `text/html`: it is
    // arbitrary kernel-authored markup, and nothing here is a place to run it.
    const image = ['image/png', 'image/jpeg', 'image/gif'].find((mime) => data.entries.has(mime))
    if (image) {
      const payload = readMappedText(data.entries.get(image))
      if (payload) {
        outputs.push({ kind: 'image', mime: image, data: payload.text.replace(/\s+/g, '') })
        continue
      }
    }
    const plain = readMappedText(data.entries.get('text/plain'))
    if (plain) outputs.push({ kind: 'text', text: plain.text })
  }
  return outputs
}
