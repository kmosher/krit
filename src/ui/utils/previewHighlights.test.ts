import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setFileHighlights, resetFileHighlights } from './previewHighlights'

// `CSS.highlights` is one registry keyed by name, but several files can be
// previewed at once. These pin the merge: a file publishing its ranges must
// not wipe another file's, and withdrawing the last one must clear the key
// rather than leave an empty highlight behind.

class FakeHighlight {
  ranges: unknown[]
  constructor(...ranges: unknown[]) {
    this.ranges = ranges
  }
  get size() {
    return this.ranges.length
  }
}

let store: Map<string, FakeHighlight>

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('Highlight', FakeHighlight)
  vi.stubGlobal('CSS', { highlights: store })
  resetFileHighlights()
})

afterEach(() => {
  resetFileHighlights()
  vi.unstubAllGlobals()
})

const range = (): Range => document.createRange()

describe('setFileHighlights', () => {
  it('merges every open file into the single registry entry', () => {
    setFileHighlights('a.md', [range(), range()])
    setFileHighlights('b.md', [range()])
    expect(store.get('krit-comment')?.size).toBe(3)
  })

  it('replaces one file\'s ranges without touching another\'s', () => {
    setFileHighlights('a.md', [range(), range()])
    setFileHighlights('b.md', [range()])
    setFileHighlights('a.md', [range()])
    expect(store.get('krit-comment')?.size).toBe(2)
  })

  it('withdraws one file and keeps the rest', () => {
    setFileHighlights('a.md', [range()])
    setFileHighlights('b.md', [range()])
    setFileHighlights('a.md', [])
    expect(store.get('krit-comment')?.size).toBe(1)
  })

  it('clears the key entirely once nothing is highlighted', () => {
    setFileHighlights('a.md', [range()])
    setFileHighlights('a.md', [])
    expect(store.has('krit-comment')).toBe(false)
  })

  it('is a no-op where the engine has no Custom Highlight API', () => {
    vi.stubGlobal('CSS', {})
    // Highlights are decoration; their absence must not throw and take the
    // whole pane down with it — the rail still lists every comment.
    expect(() => setFileHighlights('a.md', [range()])).not.toThrow()
  })
})
