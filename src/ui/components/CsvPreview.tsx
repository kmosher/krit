import { useMemo } from 'react'
import { parseDelimited } from '../utils/csvParse'
import { rangesIntersect } from '../utils/previewFormat'

// Delimited data as a table. The first row is treated as a header — nothing in
// the format says it is one, but a data file whose first row is data still
// reads correctly with that row set apart, while a real header rendered as a
// data row does not.

interface Props {
  source: string
  delimiter: string
  changedRanges: Array<[number, number]>
}

export function CsvPreview({ source, delimiter, changedRanges }: Props) {
  const rows = useMemo(() => parseDelimited(source, delimiter), [source, delimiter])
  if (rows.length === 0) return <div className="csv-preview-empty">This file is empty.</div>

  const [header, ...body] = rows
  return (
    <div className="csv-preview-body">
      <table className="csv-preview-table">
        <thead>
          <tr data-changed={rangesIntersect(changedRanges, header.startLine, header.endLine) ? 'true' : undefined}>
            <th className="csv-preview-lineno">{header.startLine}</th>
            {header.cells.map((cell, i) => (
              <th key={i} data-src={`${cell.start}-${cell.end}`}>
                {cell.text}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => {
            const changed = rangesIntersect(changedRanges, row.startLine, row.endLine)
            return (
              <tr key={r} data-changed={changed ? 'true' : undefined}>
                <td className="csv-preview-lineno">{row.startLine}</td>
                {row.cells.map((cell, i) => (
                  <td key={i} data-src={`${cell.start}-${cell.end}`}>
                    {cell.text}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
