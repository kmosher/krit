import { describe, it, expect } from 'vitest'
import { fileCacheKey, parseFileFragment } from './App'
import type { FileContentsMap } from './hooks/useDiff'

const PATCH = `diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 one
-two
+two CHANGED
`

function contents(oldText: string, newText: string): FileContentsMap[string] {
  return { old: { contents: oldText }, new: { contents: newText } } as FileContentsMap[string]
}

describe('fileCacheKey', () => {
  it('changes when the contents change', () => {
    // Pierre keys its highlight cache on this and will reuse a stale render
    // for a key it has seen before — the library's own contract is that the
    // key must move whenever the diff contents do.
    expect(fileCacheKey('a.txt', 'one')).not.toBe(fileCacheKey('a.txt', 'two'))
  })

  it('changes when the name changes', () => {
    expect(fileCacheKey('a.txt', 'one')).not.toBe(fileCacheKey('b.txt', 'one'))
  })

  it('is stable for identical inputs, so an unchanged file keeps its render', () => {
    expect(fileCacheKey('a.txt', 'one', 'two')).toBe(fileCacheKey('a.txt', 'one', 'two'))
  })

  it('separates the parts, so a shifted boundary is still a different key', () => {
    expect(fileCacheKey('a.txt', 'ab', 'c')).not.toBe(fileCacheKey('a.txt', 'a', 'bc'))
  })

  it('starts with the file name, so a key is legible in a debugger', () => {
    expect(fileCacheKey('src/a.rs', 'x').startsWith('src/a.rs#')).toBe(true)
  })
})

describe('parseFileFragment cache keys', () => {
  it('gives every parsed file a key', () => {
    expect(parseFileFragment('a.txt', PATCH, undefined).cacheKey).toBeTruthy()
  })

  it('moves the key when only the bundled contents changed', () => {
    // The patch fragment can be byte-identical while the full file around it
    // differs, and the upgraded render is built from the contents — so the
    // fragment alone is not enough to tell two renders apart.
    const a = parseFileFragment('a.txt', PATCH, contents('one\ntwo\n', 'one\ntwo CHANGED\n'))
    const b = parseFileFragment('a.txt', PATCH, contents('one\ntwo\n', 'one\ntwo OTHER\n'))
    expect(a.cacheKey).not.toBe(b.cacheKey)
  })

  it('keeps the key stable when nothing changed', () => {
    const entry = contents('one\ntwo\n', 'one\ntwo CHANGED\n')
    expect(parseFileFragment('a.txt', PATCH, entry).cacheKey).toBe(
      parseFileFragment('a.txt', PATCH, entry).cacheKey,
    )
  })
})
