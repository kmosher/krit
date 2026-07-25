import { describe, it, expect } from 'vitest'
import { spliceFilePatches, splitFilePatches } from './useDiff'

// One file's unified-diff fragment. Kept tiny; the merge logic only cares
// about `diff --git` boundaries and the b/-side path, not hunk contents.
function fragment(path: string, body = '+changed'): string {
  return [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1 +1 @@`,
    `-original`,
    body,
  ].join('\n')
}

const A = fragment('src/a.rs')
const B = fragment('src/b.rs')
const C = fragment('src/c.rs')

describe('splitFilePatches', () => {
  it('splits a multi-file patch into one fragment per b/-side path, in order', () => {
    const map = splitFilePatches([A, B, C].join('\n'))
    expect([...map.keys()]).toEqual(['src/a.rs', 'src/b.rs', 'src/c.rs'])
    expect(map.get('src/a.rs')).toBe(A)
    expect(map.get('src/b.rs')).toBe(B)
    expect(map.get('src/c.rs')).toBe(C)
  })

  it('returns an empty map for an empty patch', () => {
    expect(splitFilePatches('').size).toBe(0)
  })

  it('keys on the raw (unquoted) non-ASCII b/-side path', () => {
    const map = splitFilePatches(fragment('src/café.rs'))
    expect([...map.keys()]).toEqual(['src/café.rs'])
  })

  it('keys a rename on the new (b/) path, not the old', () => {
    const rename = [
      'diff --git a/old/name.rs b/new/name.rs',
      'similarity index 100%',
      'rename from old/name.rs',
      'rename to new/name.rs',
    ].join('\n')
    expect([...splitFilePatches(rename).keys()]).toEqual(['new/name.rs'])
  })
})

describe('spliceFilePatches', () => {
  it('replaces one file in place and leaves the others byte-identical', () => {
    const full = [A, B, C].join('\n')
    const Bprime = fragment('src/b.rs', '+edited-again')
    const out = spliceFilePatches(full, new Map([['src/b.rs', Bprime]]))
    expect(out).toBe([A, Bprime, C].join('\n'))
  })

  it('removes a file when its fragment is the empty string', () => {
    const full = [A, B, C].join('\n')
    const out = spliceFilePatches(full, new Map([['src/b.rs', '']]))
    expect(out).toBe([A, C].join('\n'))
  })

  it('appends a fragment whose path was not already in the patch', () => {
    const full = [A].join('\n')
    const out = spliceFilePatches(full, new Map([['src/c.rs', C]]))
    expect(out).toBe([A, C].join('\n'))
  })

  it('does not append an empty fragment for a path not in the patch', () => {
    const full = A
    const out = spliceFilePatches(full, new Map([['src/gone.rs', '']]))
    expect(out).toBe(A)
  })

  it('appends every fragment when the base patch is empty', () => {
    const out = spliceFilePatches('', new Map([
      ['src/a.rs', A],
      ['src/b.rs', B],
    ]))
    expect(out).toBe([A, B].join('\n'))
  })

  it('handles a batch that replaces one file and adds another in a single pass', () => {
    const full = [A, B].join('\n')
    const Bprime = fragment('src/b.rs', '+B2')
    const out = spliceFilePatches(full, new Map([
      ['src/b.rs', Bprime],
      ['src/c.rs', C],
    ]))
    expect(out).toBe([A, Bprime, C].join('\n'))
  })

  it('round-trips: splicing a scoped re-fetch of a subset reproduces the whole patch when nothing changed', () => {
    const full = [A, B, C].join('\n')
    // A scoped GET /api/diff?file=src/b.rs response, split then spliced back.
    const scoped = splitFilePatches(B)
    expect(spliceFilePatches(full, scoped)).toBe(full)
  })
})
