// The b/-side path out of a `diff --git a/X b/Y` header, or null if the line
// isn't one.
//
// The header is ambiguous: a path may itself contain " b/" (`foo b/bar.rs`
// yields `diff --git a/foo b/bar.rs b/foo b/bar.rs`), so neither the first nor
// the last " b/" is reliably the separator. Absent a rename git writes the same
// path on both sides, so the split point is fixed by length symmetry — the only
// offset where the halves are identical is the real separator. Only a rename,
// where the sides genuinely differ, falls back to the first " b/", which is
// unambiguous for the paths git can produce there (a path needing a literal
// " b/" on one side of a rename is quoted by git).
//
// `diff_header_path` / `extract_file_patch` in krit/src/server.rs key the same
// fragments from the same headers and must agree with this exactly; a
// divergence mis-keys a file's diff on one side only. Keep them in lockstep —
// this being one function on the TypeScript side is the point.
export function diffHeaderPath(line: string): string | null {
  const prefix = 'diff --git a/'
  if (!line.startsWith(prefix)) return null
  const rest = line.slice(prefix.length)
  const half = (rest.length - 3) / 2
  if (Number.isInteger(half) && half > 0) {
    const candidate = rest.slice(rest.length - half)
    if (rest === `${candidate} b/${candidate}`) return candidate
  }
  const sep = rest.indexOf(' b/')
  return sep === -1 ? null : rest.slice(sep + 3)
}
