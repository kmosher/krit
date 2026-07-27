import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { spliceFilePatches, splitFilePatches, useDiff, type UseDiffOptions } from './useDiff'

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

// --- the stale/editing state machine -----------------------------------
//
// These drive the hook rather than a pure function, because every bug this
// half of useDiff can have lives in a transition: which paths a refresh
// actually fetches, which survive in staleFiles, and whether a file with a
// live editor is spared the refetch that would destroy its document.

// A minimal EventSource stand-in — happy-dom has none, and the tests need to
// deliver SSE frames on demand rather than wait for a server.
class FakeEventSource {
  static last: FakeEventSource | null = null
  listeners: Array<(ev: { data: string }) => void> = []
  closed = false
  constructor(public url: string) {
    FakeEventSource.last = this
  }
  addEventListener(_type: string, fn: (ev: { data: string }) => void) {
    this.listeners.push(fn)
  }
  close() {
    this.closed = true
  }
  emit(payload: unknown) {
    const data = JSON.stringify(payload)
    for (const fn of this.listeners) fn({ data })
  }
}

function diffResponse(paths: string[]) {
  return {
    patch: paths.map((p) => fragment(p)).join('\n'),
    repoName: 'krit',
    branch: 'main',
    customMode: false,
    binaryFiles: [],
    untrackedFiles: [],
    fileContents: {},
  }
}

// Every /api/diff URL the hook requested, in order. Scoped refetches carry one
// `file=` param per path, which is how a test tells what was actually fetched.
let requested: string[] = []

function fetchedPathsFor(url: string): string[] {
  return [...new URL(url, 'http://localhost').searchParams.getAll('file')]
}

function renderUseDiff(overrides: Partial<UseDiffOptions> = {}) {
  const options: UseDiffOptions = {
    staged: false,
    untracked: false,
    refreshMode: 'live-unless-active',
    activeFiles: new Set(),
    editingFiles: new Set(),
    ...overrides,
  }
  return renderHook((props: UseDiffOptions) => useDiff(props), { initialProps: options })
}

beforeEach(() => {
  requested = []
  FakeEventSource.last = null
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requested.push(url)
      const paths = fetchedPathsFor(url)
      return {
        ok: true,
        json: async () => diffResponse(paths.length > 0 ? paths : ['src/a.rs', 'src/b.rs']),
      }
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useDiff — deferring changes for files with a live editor', () => {
  it('queues a file-changed for an editing file instead of refetching it', async () => {
    const { result } = renderUseDiff({ editingFiles: new Set(['src/a.rs']) })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    requested = []

    act(() => FakeEventSource.last!.emit({ type: 'file-changed', path: 'src/a.rs' }))

    await waitFor(() => expect(result.current.staleFiles.has('src/a.rs')).toBe(true))
    expect(requested).toEqual([])
  })

  it('queues file-written too — the event that otherwise always applies', async () => {
    // file-written bypasses refreshMode by design (an explicit save), but a
    // refetch would swap the item's fileDiff out from under a live document,
    // and PUT /api/file-content is exactly how another agent writes.
    const { result } = renderUseDiff({ editingFiles: new Set(['src/a.rs']) })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    requested = []

    act(() => FakeEventSource.last!.emit({ type: 'file-written', path: 'src/a.rs' }))

    await waitFor(() => expect(result.current.staleFiles.has('src/a.rs')).toBe(true))
    expect(requested).toEqual([])
  })

  it('still refetches file-written immediately for a file nobody is editing', async () => {
    const { result } = renderUseDiff({ editingFiles: new Set(['src/a.rs']) })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    requested = []

    act(() => FakeEventSource.last!.emit({ type: 'file-written', path: 'src/b.rs' }))

    await waitFor(() => expect(requested.length).toBe(1))
    expect(fetchedPathsFor(requested[0])).toEqual(['src/b.rs'])
    expect(result.current.staleFiles.has('src/b.rs')).toBe(false)
  })

  it('defers an editing file even in ultra mode, which otherwise applies everything', async () => {
    const { result } = renderUseDiff({
      refreshMode: 'ultra',
      editingFiles: new Set(['src/a.rs']),
    })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    requested = []

    act(() => FakeEventSource.last!.emit({ type: 'file-changed', path: 'src/a.rs' }))

    await waitFor(() => expect(result.current.staleFiles.has('src/a.rs')).toBe(true))
    expect(requested).toEqual([])
  })
})

describe('useDiff — draining the queue', () => {
  it('applyAllStale refetches every queued path and empties the queue', async () => {
    const { result } = renderUseDiff({ refreshMode: 'manual' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    act(() => FakeEventSource.last!.emit({ type: 'files-changed', paths: ['src/a.rs', 'src/b.rs'] }))
    await waitFor(() => expect(result.current.staleFiles.size).toBe(2))
    requested = []

    act(() => result.current.applyAllStale())

    await waitFor(() => expect(result.current.staleFiles.size).toBe(0))
    expect(requested.length).toBe(1)
    expect(fetchedPathsFor(requested[0]).sort()).toEqual(['src/a.rs', 'src/b.rs'])
  })

  it('applyAllStale(skip) leaves skipped paths queued and fetches only the rest', async () => {
    const { result } = renderUseDiff({ refreshMode: 'manual' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    act(() => FakeEventSource.last!.emit({ type: 'files-changed', paths: ['src/a.rs', 'src/b.rs'] }))
    await waitFor(() => expect(result.current.staleFiles.size).toBe(2))
    requested = []

    act(() => result.current.applyAllStale(new Set(['src/a.rs'])))

    // The skipped path keeps its queue entry, which is what keeps its own
    // Apply affordance lit after a toolbar refresh.
    await waitFor(() => expect([...result.current.staleFiles]).toEqual(['src/a.rs']))
    expect(requested.length).toBe(1)
    expect(fetchedPathsFor(requested[0])).toEqual(['src/b.rs'])
  })

  it('does not drop a path that goes stale between render and the refresh click', async () => {
    // The regression: computing the refetch list from the render's staleFiles
    // while clearing state from `prev` deletes the newcomer without fetching
    // it — the change disappears and the badge reads zero.
    const { result } = renderUseDiff({ refreshMode: 'manual' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    act(() => FakeEventSource.last!.emit({ type: 'files-changed', paths: ['src/a.rs'] }))
    await waitFor(() => expect(result.current.staleFiles.size).toBe(1))
    requested = []

    // Both in one act(): the second path is queued and the refresh fires
    // before React re-renders, so the callback's closure never sees it.
    act(() => {
      FakeEventSource.last!.emit({ type: 'files-changed', paths: ['src/b.rs'] })
      result.current.applyAllStale()
    })

    await waitFor(() => expect(requested.length).toBeGreaterThan(0))
    const fetched = requested.flatMap(fetchedPathsFor).sort()
    expect(fetched).toEqual(['src/a.rs', 'src/b.rs'])
    await waitFor(() => expect(result.current.staleFiles.size).toBe(0))
  })

  it('dismissStale clears a path without fetching it', async () => {
    // The editor path: applyExternalEdit already put the change in the
    // document, so a refetch here would be both wasteful and destructive.
    const { result } = renderUseDiff({ editingFiles: new Set(['src/a.rs']) })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    act(() => FakeEventSource.last!.emit({ type: 'file-changed', path: 'src/a.rs' }))
    await waitFor(() => expect(result.current.staleFiles.has('src/a.rs')).toBe(true))
    requested = []

    act(() => result.current.dismissStale('src/a.rs'))

    await waitFor(() => expect(result.current.staleFiles.has('src/a.rs')).toBe(false))
    expect(requested).toEqual([])
  })
})
