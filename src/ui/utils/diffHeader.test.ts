import { describe, it, expect } from 'vitest'
import { diffHeaderPath } from './diffHeader'

describe('diffHeaderPath', () => {
  it('takes the b/-side of an ordinary header', () => {
    expect(diffHeaderPath('diff --git a/src/a.rs b/src/a.rs')).toBe('src/a.rs')
  })

  it('takes the b/-side of a path that itself contains " b/"', () => {
    // git writes both sides verbatim, so `foo b/bar.rs` produces a header with
    // three " b/" occurrences and only the length-symmetric split is right.
    expect(diffHeaderPath('diff --git a/foo b/bar.rs b/foo b/bar.rs')).toBe('foo b/bar.rs')
  })

  it('takes the whole path when only its tail looks like a second path', () => {
    expect(diffHeaderPath('diff --git a/src/foo b/bar.rs b/src/foo b/bar.rs')).toBe('src/foo b/bar.rs')
  })

  it('falls back to the first " b/" for a rename, whose sides differ', () => {
    expect(diffHeaderPath('diff --git a/old/name.rs b/new/name.rs')).toBe('new/name.rs')
  })

  it('reads a rename of equal-length paths by symmetry failure, not by length alone', () => {
    // Same length on both sides, so the symmetric split lands on a " b/" that
    // isn't there — the halves must be compared, not just measured.
    expect(diffHeaderPath('diff --git a/aaa.rs b/bbb.rs')).toBe('bbb.rs')
  })

  it('keeps a rename destination that itself contains " b/"', () => {
    // The first separator is the correct reading here: the a/-side is written
    // first and git quotes any path that would make the prefix ambiguous.
    expect(diffHeaderPath('diff --git a/old.rs b/new b/x.rs')).toBe('new b/x.rs')
  })

  it('requires the halves to match, not merely to line up around a " b/"', () => {
    // Equal-length sides that both contain " b/" put a separator exactly at the
    // midpoint without the split being real, so position alone would accept the
    // wrong tail. Only a rename can produce differing sides, and there the
    // first separator is the reading git's own quoting rules guarantee.
    expect(diffHeaderPath('diff --git a/aa b/cc b/dd b/ee')).toBe('cc b/dd b/ee')
  })

  it('preserves a raw non-ASCII path', () => {
    expect(diffHeaderPath('diff --git a/src/café.rs b/src/café.rs')).toBe('src/café.rs')
  })

  it('returns null for a line that is not a diff header', () => {
    expect(diffHeaderPath('+++ b/src/a.rs')).toBeNull()
    expect(diffHeaderPath('@@ -1 +1 @@')).toBeNull()
  })

  it('returns null for a header with no b/-side at all', () => {
    expect(diffHeaderPath('diff --git a/src/a.rs')).toBeNull()
  })
})
