// One registry for the comment highlights painted over rendered documents.
//
// The CSS Custom Highlight API is keyed globally — `CSS.highlights` is a
// registry on the document, and `::highlight(krit-comment)` names one entry —
// but several files can be open in preview at once, each owning its own
// ranges. So each pane publishes its ranges here and the merged set is
// written back, instead of every pane racing to overwrite one key.

const HIGHLIGHT_NAME = 'krit-comment'

const byFile = new Map<string, Range[]>()

interface HighlightRegistry {
  set(name: string, value: unknown): void
  delete(name: string): void
}

function registry(): HighlightRegistry | null {
  const highlights = (CSS as unknown as { highlights?: HighlightRegistry }).highlights
  // Absent in older engines and in happy-dom; highlights are decoration, so
  // their absence degrades to "the rail still lists every comment".
  if (!highlights || typeof Highlight === 'undefined') return null
  return highlights
}

/** Publishes one file's highlight ranges. An empty array withdraws them. */
export function setFileHighlights(filePath: string, ranges: Range[]): void {
  if (ranges.length === 0) byFile.delete(filePath)
  else byFile.set(filePath, ranges)

  const store = registry()
  if (!store) return

  const all: Range[] = []
  for (const list of byFile.values()) all.push(...list)
  if (all.length === 0) store.delete(HIGHLIGHT_NAME)
  else store.set(HIGHLIGHT_NAME, new Highlight(...all))
}

/** Test seam: forget every registered range. */
export function resetFileHighlights(): void {
  byFile.clear()
  registry()?.delete(HIGHLIGHT_NAME)
}
