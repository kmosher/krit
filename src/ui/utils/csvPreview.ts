// Delimited data read as a table. Anchoring here is the easy case in the whole
// preview family: a field's decoded text occurs verbatim inside its own source
// span (quotes only bracket it), so the locate-by-value rule in
// `previewAnchor.ts` is exact without any offset map. Only a doubled `""`
// inside a quoted field breaks the correspondence, and that snaps outward to
// the cell — a superset of the selection, which is always safe.

export interface CsvCell {
  text: string
  /** File offsets of the field as written, quotes included. */
  start: number
  end: number
}

export interface CsvRow {
  cells: CsvCell[]
  /** 1-based file lines this row occupies — more than one if a field is quoted
   *  across a newline, which is why rows are not `source.split('\n')`. */
  startLine: number
  endLine: number
}

export function delimiterFor(path: string): string {
  return /\.tsv$|\.tab$/i.test(path) ? '\t' : ','
}

export function parseDelimited(source: string, delimiter: string): CsvRow[] {
  const rows: CsvRow[] = []
  let cells: CsvCell[] = []
  let line = 1
  let rowStartLine = 1
  let i = 0
  // True once a delimiter has been consumed: the field after it exists even if
  // the file ends immediately, so `a,` is two cells and not one.
  let fieldPending = false

  const endRow = () => {
    rows.push({ cells, startLine: rowStartLine, endLine: line })
    cells = []
  }

  while (i <= source.length) {
    if (i === source.length) {
      if (fieldPending) cells.push({ text: '', start: i, end: i })
      // A trailing newline closes the last row; anything else leaves one final
      // field to flush. An empty file yields no rows at all.
      if (cells.length > 0) endRow()
      break
    }
    fieldPending = false

    const start = i
    let text = ''
    if (source[i] === '"') {
      i++
      while (i < source.length) {
        if (source[i] === '"') {
          if (source[i + 1] === '"') {
            text += '"'
            i += 2
            continue
          }
          i++
          break
        }
        if (source[i] === '\n') line++
        text += source[i]
        i++
      }
    } else {
      while (i < source.length && source[i] !== delimiter && source[i] !== '\n') {
        text += source[i]
        i++
      }
      // A CRLF file would otherwise carry the CR into the last field of a row.
      if (text.endsWith('\r')) text = text.slice(0, -1)
    }
    cells.push({ text, start, end: i })

    if (i < source.length && source[i] === delimiter) {
      i++
      fieldPending = true
      continue
    }
    if (i < source.length && source[i] === '\n') {
      i++
      // The row ends *on* this line; the newline starts the next one.
      endRow()
      line++
      rowStartLine = line
      // A trailing newline at EOF must not open an empty final row.
      if (i === source.length) break
      continue
    }
    if (i >= source.length) {
      endRow()
      break
    }
    // A quoted field followed by stray text before the delimiter: consume it
    // into the same cell rather than losing it.
    while (i < source.length && source[i] !== delimiter && source[i] !== '\n') {
      text += source[i]
      i++
    }
    cells[cells.length - 1] = { text, start, end: i }
  }

  return rows
}
