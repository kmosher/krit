import { useMemo } from 'react'
import { parseNotebook, toFileOffset, type NotebookCell } from '../utils/notebookParse'
import { rangesIntersect } from '../utils/previewFormat'
import { MarkdownPreview } from './MarkdownPreview'

// A notebook rendered as cells. Markdown cells go through the same renderer a
// `.md` file does, with the offsets it stamps translated back through the
// cell's JSON string map; code cells are stamped a line at a time. Outputs are
// deliberately left unstamped — there is no source position behind a rendered
// figure, and an unstamped subtree yields no anchor rather than a wrong one.

interface Props {
  source: string
  changedRanges: Array<[number, number]>
}

export function NotebookPreview({ source, changedRanges }: Props) {
  const notebook = useMemo(() => parseNotebook(source), [source])

  if (!notebook) {
    return (
      <div className="notebook-preview-error">
        This file isn’t valid notebook JSON, so there is nothing to render. Close the preview to
        read its diff.
      </div>
    )
  }

  return (
    <div className="notebook-preview-body">
      {notebook.cells.map((cell) => (
        <Cell
          key={cell.index}
          cell={cell}
          changed={rangesIntersect(changedRanges, cell.startLine, cell.endLine)}
        />
      ))}
    </div>
  )
}

function Cell({ cell, changed }: { cell: NotebookCell; changed: boolean }) {
  // Stable per cell: MarkdownPreview keys its plugin memo on this, so a fresh
  // closure every render would reparse the cell on every keystroke elsewhere.
  const mapOffset = useMemo(
    () => (offset: number) => toFileOffset(cell.source, offset),
    [cell.source],
  )

  return (
    <section className="notebook-cell" data-cell-type={cell.type}>
      <div className="notebook-cell-gutter">
        {cell.type === 'code'
          ? cell.executionCount != null
            ? `[${cell.executionCount}]`
            : '[ ]'
          : cell.type}
      </div>
      <div className="notebook-cell-body">
        {cell.type === 'markdown' ? (
          <MarkdownPreview
            source={cell.source.text}
            changedRanges={[]}
            changed={changed}
            mapOffset={mapOffset}
          />
        ) : (
          <CellSource cell={cell} changed={changed} />
        )}
        {cell.outputs.map((out, i) => (
          <div key={i} className={`notebook-output notebook-output-${out.kind}`}>
            {out.kind === 'image' ? (
              <img src={`data:${out.mime};base64,${out.data}`} alt="Cell output" />
            ) : (
              <pre>{out.text}</pre>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * A code (or raw) cell, stamped twice over: the cell's whole span on the
 * `<pre>`, and each line's own span on the row inside it.
 *
 * The per-line spans are what make an exact anchor possible. The locate-by-
 * value rule in `previewAnchor.ts` searches an element's source slice for the
 * text node's exact value, and a line is a run that really does occur verbatim
 * inside its own JSON string literal — a whole cell's text, with real newlines
 * where the file has `\n",\n "`, does not. The cell span is what a selection
 * crossing two lines snaps outward to.
 */
function CellSource({ cell, changed }: { cell: NotebookCell; changed: boolean }) {
  const lines = useMemo(() => {
    const out: Array<{ text: string; start: number; end: number }> = []
    let at = 0
    for (const text of cell.source.text.split('\n')) {
      out.push({ text, start: at, end: at + text.length })
      at += text.length + 1
    }
    // A cell whose source ends in a newline gets one empty trailing line from
    // the split; it renders nothing and only adds a row.
    if (out.length > 1 && out[out.length - 1].text === '') out.pop()
    return out
  }, [cell.source.text])

  return (
    <pre
      className="notebook-cell-source"
      data-src={`${cell.source.start}-${cell.source.end}`}
      data-changed={changed ? 'true' : undefined}
    >
      {lines.map((line, i) => (
        <span
          key={i}
          className="notebook-source-line"
          data-src={`${toFileOffset(cell.source, line.start)}-${toFileOffset(cell.source, line.end)}`}
        >
          {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}
