import { describe, it, expect } from 'vitest'
import {
  changedNewLines,
  previewFormatFor,
  rangesIntersect,
  toLineRanges,
} from './previewFormat'

describe('previewFormatFor', () => {
  it('recognises markdown and html by extension, case-insensitively', () => {
    expect(previewFormatFor('docs/design/tui.md')).toBe('markdown')
    expect(previewFormatFor('README.MARKDOWN')).toBe('markdown')
    expect(previewFormatFor('report.html')).toBe('html')
    expect(previewFormatFor('a/b/index.htm')).toBe('html')
  })

  it('declines anything without a renderer', () => {
    expect(previewFormatFor('src/main.rs')).toBeNull()
    expect(previewFormatFor('Makefile')).toBeNull()
    // A dotfile's leading dot does not make its name an extension.
    expect(previewFormatFor('.gitignore')).toBeNull()
    // The directory's extension is not the file's.
    expect(previewFormatFor('docs.md/notes.txt')).toBeNull()
  })
})

describe('changedNewLines', () => {
  it('numbers added lines on the new side, skipping deletions', () => {
    const fragment = [
      'diff --git a/doc.md b/doc.md',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,4 +1,5 @@',
      ' # Title',
      ' ',
      '-old line',
      '+new line',
      '+another new line',
      ' trailing context',
    ].join('\n')
    // Lines 1,2 context; 3 and 4 added; 5 context.
    expect([...changedNewLines(fragment)]).toEqual([3, 4])
  })

  it('tracks the hunk header offset rather than counting from one', () => {
    const fragment = ['@@ -40,3 +52,4 @@', ' ctx', '+added', ' ctx'].join('\n')
    expect([...changedNewLines(fragment)]).toEqual([53])
  })

  it('does not bleed line numbers across files when handed a whole patch', () => {
    const patch = [
      'diff --git a/a.md b/a.md',
      '@@ -1 +1 @@',
      '+first file',
      'diff --git a/b.md b/b.md',
      '@@ -1 +9 @@',
      '+second file',
    ].join('\n')
    // 1 from a.md, 9 from b.md — not 1 and 2.
    expect([...changedNewLines(patch)].sort((x, y) => x - y)).toEqual([1, 9])
  })

  it('ignores the no-newline marker', () => {
    const fragment = ['@@ -1 +1,2 @@', ' ctx', '+added', '\\ No newline at end of file'].join('\n')
    expect([...changedNewLines(fragment)]).toEqual([2])
  })

  it('is empty for a patch with no hunks', () => {
    expect(changedNewLines('').size).toBe(0)
    expect(changedNewLines('diff --git a/x b/x\nBinary files differ\n').size).toBe(0)
  })
})

describe('toLineRanges', () => {
  it('collapses runs and leaves gaps alone', () => {
    expect(toLineRanges(new Set([3, 4, 5, 9, 11, 12]))).toEqual([
      [3, 5],
      [9, 9],
      [11, 12],
    ])
  })

  it('sorts before collapsing, since a Set has no order', () => {
    expect(toLineRanges(new Set([5, 3, 4]))).toEqual([[3, 5]])
  })
})

describe('rangesIntersect', () => {
  const ranges: Array<[number, number]> = [
    [3, 5],
    [10, 10],
  ]
  it('is true when a block overlaps a changed run at all', () => {
    expect(rangesIntersect(ranges, 1, 3)).toBe(true) // touches at the start
    expect(rangesIntersect(ranges, 5, 20)).toBe(true) // touches at the end
    expect(rangesIntersect(ranges, 4, 4)).toBe(true) // contained
    expect(rangesIntersect(ranges, 1, 99)).toBe(true) // contains
  })
  it('is false for a block entirely between changes', () => {
    expect(rangesIntersect(ranges, 6, 9)).toBe(false)
    expect(rangesIntersect([], 1, 100)).toBe(false)
  })
})
