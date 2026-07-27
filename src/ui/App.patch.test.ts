import { describe, it, expect } from 'vitest'
import {
  splitPatchFragments,
  computeFileStats,
  parseFileFragment,
  editToggleAction,
  withEntry,
  withoutEntry,
  undoToastLabel,
} from './App'
import type { FileContentsMap } from './hooks/useDiff'

function fragment(path: string, additions = 1, deletions = 1): string {
  const lines = [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${deletions} +1,${additions} @@`,
  ]
  for (let i = 0; i < deletions; i++) lines.push(`-old line ${i}`)
  for (let i = 0; i < additions; i++) lines.push(`+new line ${i}`)
  return lines.join('\n')
}

describe('splitPatchFragments', () => {
  it('splits a multi-file patch into ordered {name,text} fragments keyed on the b/ path', () => {
    const a = fragment('src/a.rs')
    const b = fragment('src/b.rs')
    const frags = splitPatchFragments([a, b].join('\n'))
    expect(frags.map((f) => f.name)).toEqual(['src/a.rs', 'src/b.rs'])
    expect(frags[0].text).toBe(a)
    expect(frags[1].text).toBe(b)
  })

  it('returns nothing for an empty patch', () => {
    expect(splitPatchFragments('')).toEqual([])
  })

  it('preserves a raw non-ASCII path', () => {
    expect(splitPatchFragments(fragment('src/café.rs'))[0].name).toBe('src/café.rs')
  })
})

describe('computeFileStats', () => {
  it('counts +/- content lines and ignores the +++/--- headers', () => {
    expect(computeFileStats(fragment('src/a.rs', 3, 2))).toEqual({ additions: 3, deletions: 2 })
  })

  it('is zero for a fragment with no hunk body', () => {
    expect(computeFileStats('diff --git a/x b/x\nindex 1..2 100644')).toEqual({
      additions: 0,
      deletions: 0,
    })
  })
})

describe('parseFileFragment', () => {
  // Regression guard for the non-ASCII display fix: @pierre/diffs re-emits a
  // parsed file's .name in git C-quoted octal form ("src/caf\303\251.rs") for
  // non-ASCII paths. parseFileFragment must pin .name to the unquoted fragment
  // name we pass in, so display/tree/comment keys all agree.
  it('pins .name to the given unquoted name for a non-ASCII path (patch-only)', () => {
    const file = parseFileFragment('src/café.rs', fragment('src/café.rs'), undefined)
    expect(file.name).toBe('src/café.rs')
  })

  it('pins .name when upgraded to full-file with bundled contents', () => {
    const path = 'src/café.rs'
    const contents: FileContentsMap = {
      [path]: { old: { contents: 'old\n' }, new: { contents: 'new\n' } },
    }
    const file = parseFileFragment(path, fragment(path), contents[path])
    expect(file.name).toBe(path)
  })

  it('falls back to a partial stub with the given name when the fragment cannot be parsed', () => {
    const file = parseFileFragment('src/weird.rs', 'not a diff at all', undefined)
    expect(file.name).toBe('src/weird.rs')
    expect(file.isPartial).toBe(true)
    expect(file.hunks).toEqual([])
  })
})

describe('editToggleAction', () => {
  it('toggles freely when nothing is queued', () => {
    expect(editToggleAction({ editing: false, stale: false, confirming: false })).toBe('toggle')
    expect(editToggleAction({ editing: true, stale: false, confirming: false })).toBe('toggle')
  })

  it('asks before saving over a queued change', () => {
    expect(editToggleAction({ editing: true, stale: true, confirming: false })).toBe('ask')
  })

  it('lets the save through once the question is already up', () => {
    expect(editToggleAction({ editing: true, stale: true, confirming: true })).toBe('toggle')
  })

  it('never asks on the way in — a queued change is not a reason to refuse to open an editor', () => {
    expect(editToggleAction({ editing: false, stale: true, confirming: false })).toBe('toggle')
  })
})

describe('withEntry / withoutEntry', () => {
  it('keeps an existing entry when a second one is added', () => {
    // The regression: a single-slot conflict holder loses the first file's
    // only surviving copy of its refused save the moment a second save fails.
    const one = withEntry(new Map<string, string>(), 'src/a.rs', 'a-text')
    const two = withEntry(one, 'src/b.rs', 'b-text')
    expect([...two]).toEqual([
      ['src/a.rs', 'a-text'],
      ['src/b.rs', 'b-text'],
    ])
    expect(two.get('src/a.rs')).toBe('a-text')
  })

  it('does not mutate the map it was given', () => {
    const before = withEntry(new Map<string, string>(), 'src/a.rs', 'a-text')
    withEntry(before, 'src/b.rs', 'b-text')
    withoutEntry(before, 'src/a.rs')
    expect([...before.keys()]).toEqual(['src/a.rs'])
  })

  it('replaces the held contents when the same path fails twice', () => {
    const map = withEntry(withEntry(new Map<string, string>(), 'src/a.rs', 'first'), 'src/a.rs', 'second')
    expect(map.size).toBe(1)
    expect(map.get('src/a.rs')).toBe('second')
  })

  it('removes only the named entry, and returns the same map for a miss', () => {
    const map = withEntry(withEntry(new Map<string, string>(), 'a', '1'), 'b', '2')
    expect([...withoutEntry(map, 'a').keys()]).toEqual(['b'])
    expect(withoutEntry(map, 'c')).toBe(map)
  })
})

describe('undoToastLabel', () => {
  it('is null with nothing queued', () => {
    expect(undoToastLabel([])).toBeNull()
  })

  it('shows the head message alone when it is the only one', () => {
    expect(undoToastLabel([{ message: 'Deleted "x"' }])).toBe('Deleted "x"')
  })

  it('counts the ones still waiting behind the head', () => {
    // Without the count, a second delete looks like it replaced the first, and
    // the first undo id has no handle left in the UI.
    expect(
      undoToastLabel([{ message: 'Deleted "x"' }, { message: 'Deleted "y"' }, { message: 'Deleted "z"' }]),
    ).toBe('Deleted "x" (+2 more)')
  })
})
