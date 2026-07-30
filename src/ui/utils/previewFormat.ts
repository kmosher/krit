// Which files krit can render as a document instead of a diff, and which of
// their lines the current diff touched.

export type PreviewFormat = 'markdown' | 'html'

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])
const HTML_EXT = new Set(['html', 'htm'])

/** null for anything krit has no renderer for — the caller shows no toggle. */
export function previewFormatFor(path: string): PreviewFormat | null {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = base.slice(dot + 1).toLowerCase()
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  if (HTML_EXT.has(ext)) return 'html'
  return null
}

/**
 * New-side line numbers this file's patch fragment adds or modifies, so the
 * preview can mark the blocks that changed. Context and removed lines are not
 * included: a rendered document has nowhere to show a line that is no longer
 * in it.
 *
 * Accepts either a `diff --git` fragment or a bare sequence of hunks.
 */
export function changedNewLines(fragment: string): Set<number> {
  const changed = new Set<number>()
  if (!fragment) return changed
  let lineNo = 0
  let inHunk = false
  for (const line of fragment.split('\n')) {
    if (line.startsWith('@@')) {
      // @@ -old,count +new,count @@
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        lineNo = Number(m[1])
        inHunk = true
      } else {
        inHunk = false
      }
      continue
    }
    if (!inHunk) continue
    // A `diff --git` header ends the previous file's hunks; a fragment should
    // only hold one file, but a caller passing the whole patch shouldn't bleed
    // line numbers across files.
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    if (line.startsWith('+')) {
      changed.add(lineNo)
      lineNo++
    } else if (line.startsWith('-')) {
      // Consumes an old-side line only; the new-side cursor stays put.
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — belongs to the preceding line.
    } else {
      // Context (leading space) and, defensively, a stray empty line, which
      // git emits for an empty context line in some diff configurations.
      lineNo++
    }
  }
  return changed
}

/**
 * Collapses line numbers into inclusive [start, end] ranges, which is the
 * shape the renderer needs to ask "did this block change" with one comparison
 * per range instead of one per line.
 */
export function toLineRanges(lines: Set<number>): Array<[number, number]> {
  const sorted = [...lines].sort((a, b) => a - b)
  const ranges: Array<[number, number]> = []
  for (const n of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && n === last[1] + 1) last[1] = n
    else ranges.push([n, n])
  }
  return ranges
}

export function rangesIntersect(
  ranges: Array<[number, number]>,
  start: number,
  end: number,
): boolean {
  for (const [a, b] of ranges) {
    if (a <= end && b >= start) return true
  }
  return false
}
