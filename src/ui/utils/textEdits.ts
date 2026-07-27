import type { TextEdit } from '@pierre/diffs'

// A high surrogate is the first code unit of a surrogate pair; slicing between
// it and its partner would produce a lone surrogate and corrupt the character.
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

// Pierre's Position is explicitly line-end agnostic: a position denoting the
// gap in `\r|\n` is not expressible. A boundary landing there has to move off
// it, which line-ending normalization (an agent rewriting CRLF to LF) hits.
function splitsCRLF(text: string, offset: number): boolean {
  return offset > 0 && text.charCodeAt(offset - 1) === 13 && text.charCodeAt(offset) === 10
}

// Zero-based {line, character} for a UTF-16 offset into `text`, matching the
// LSP-style Position that Pierre's TextEdit expects. `character` counts UTF-16
// code units, which is what JS string indexing already gives us — the same
// convention the comment anchors use (see selectionMapping).
function positionAt(text: string, offset: number): { line: number; character: number } {
  let line = 0
  let lineStart = 0
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      lineStart = i + 1
    }
  }
  return { line, character: offset - lineStart }
}

/**
 * The single edit that turns `oldText` into `newText`, or null if they already
 * match.
 *
 * One edit, not a per-hunk list, and that is the point: an agent's write should
 * cost the reader exactly one undo to reject, whatever it touched. The cost is
 * that a write touching two distant regions produces a range spanning the
 * untouched text between them, which is rewritten with itself.
 *
 * Trimming the common prefix and suffix keeps the usual case (one region
 * changed) tight enough that the editor's selection and markers outside it
 * survive.
 */
export function computeMinimalEdit(oldText: string, newText: string): TextEdit | null {
  if (oldText === newText) return null

  const maxPrefix = Math.min(oldText.length, newText.length)
  let prefix = 0
  while (prefix < maxPrefix && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++
  }
  // Both adjustments only ever shrink the prefix, and every code unit inside
  // it is common to both strings, so backing off stays consistent with the
  // newText slice below.
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix--
  if (splitsCRLF(oldText, prefix)) prefix--

  // Cap the suffix so it can't overlap the prefix in either string — an
  // insertion of repeated text ("ab" -> "abab") would otherwise match the same
  // code units from both ends and produce a negative-length range.
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix)
  let suffix = 0
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++
  }
  // Symmetric guard: the boundary must not fall between a surrogate pair's
  // halves. Here the character *before* the suffix start is the risk.
  // Mirror image: these only ever shrink the common suffix, growing the range
  // forward, which is likewise consistent with the newText slice.
  if (suffix > 0 && isHighSurrogate(oldText.charCodeAt(oldText.length - suffix - 1))) suffix--
  if (splitsCRLF(oldText, oldText.length - suffix)) suffix--

  return {
    range: {
      start: positionAt(oldText, prefix),
      end: positionAt(oldText, oldText.length - suffix),
    },
    newText: newText.slice(prefix, newText.length - suffix),
  }
}
