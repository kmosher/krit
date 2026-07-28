import { describe, it, expect } from 'vitest'
import { keepPaths, type DiffData } from './useDiff'

function fragment(name: string, line: string): string {
  return `diff --git a/${name} b/${name}
--- a/${name}
+++ b/${name}
@@ -1 +1 @@
-old
+${line}
`
}

function data(over: Partial<DiffData> = {}): DiffData {
  return {
    patch: fragment('a.txt', 'A') + fragment('b.txt', 'B'),
    repoName: 'demo',
    branch: 'main',
    customMode: false,
    binaryFiles: [],
    untrackedFiles: [],
    fileContents: {
      'a.txt': { old: { contents: 'old\n' }, new: { contents: 'A\n' } },
      'b.txt': { old: { contents: 'old\n' }, new: { contents: 'B\n' } },
    },
    ...over,
  }
}

describe('keepPaths', () => {
  it('returns the new data untouched when nothing was superseded', () => {
    const next = data()
    expect(keepPaths(next, data(), [])).toBe(next)
  })

  it('takes the held patch fragment for a superseded path only', () => {
    // The whole point of the full reload is that it is authoritative for every
    // path a later scoped fetch did not claim — dropping it wholesale is what
    // left `krit refresh` silently delivering nothing.
    const prev = data({
      patch: fragment('a.txt', 'HELD') + fragment('b.txt', 'HELD'),
    })
    const merged = keepPaths(data(), prev, ['a.txt'])
    expect(merged.patch).toContain('+HELD')
    expect(merged.patch).toContain('+B')
    expect(merged.patch).not.toContain('+A')
  })

  it('takes the held contents for a superseded path only', () => {
    const prev = data({
      fileContents: {
        'a.txt': { old: { contents: 'old\n' }, new: { contents: 'HELD\n' } },
        'b.txt': { old: { contents: 'old\n' }, new: { contents: 'HELD\n' } },
      },
    })
    const merged = keepPaths(data(), prev, ['a.txt'])
    expect(merged.fileContents['a.txt'].new).toEqual({ contents: 'HELD\n' })
    expect(merged.fileContents['b.txt'].new).toEqual({ contents: 'B\n' })
  })

  it('drops contents for a superseded path the scoped read no longer has', () => {
    // A file that stopped differing has no entry in the newer read; keeping the
    // reload's copy would resurrect a diff the user already resolved.
    const prev = data({ fileContents: {} })
    expect('a.txt' in keepPaths(data(), prev, ['a.txt']).fileContents).toBe(false)
  })

  it('holds binary and untracked status per path too', () => {
    const prev = data({
      binaryFiles: [{ path: 'a.txt', type: 'changed' }],
      untrackedFiles: ['a.txt'],
    })
    const next = data({
      binaryFiles: [{ path: 'b.txt', type: 'changed' }],
      untrackedFiles: ['b.txt'],
    })
    const merged = keepPaths(next, prev, ['a.txt'])
    expect(merged.binaryFiles.map((b) => b.path).sort()).toEqual(['a.txt', 'b.txt'])
    expect([...merged.untrackedFiles].sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('keeps non-per-file fields from the newer full reload', () => {
    const prev = data({ branch: 'stale', repoName: 'stale' })
    const merged = keepPaths(data(), prev, ['a.txt'])
    expect(merged.branch).toBe('main')
    expect(merged.repoName).toBe('demo')
  })
})
