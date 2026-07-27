import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  DiffRequestLedger,
  diffHeaderPath,
  spliceFilePatches,
  splitFilePatches,
  useDiff,
  type BinaryFileInfo,
  type FileContentsMap,
  type UseDiffOptions,
} from './useDiff'

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
// deliver SSE frames on demand rather than wait for a server. Listeners are
// kept per event type, so a test can prove the hook subscribed to the type the
// server actually sends and to no other.
class FakeEventSource {
  static last: FakeEventSource | null = null
  listeners = new Map<string, Array<(ev: { data: string }) => void>>()
  closed = false
  constructor(public url: string) {
    FakeEventSource.last = this
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    const forType = this.listeners.get(type) ?? []
    forType.push(fn)
    this.listeners.set(type, forType)
  }
  close() {
    this.closed = true
  }
  emit(payload: unknown, type = 'message') {
    const data = JSON.stringify(payload)
    for (const fn of this.listeners.get(type) ?? []) fn({ data })
  }
}

// The repo the fake server is serving, one entry per path with a pending
// change. A path missing from `world` is a path with no pending diff — which
// is what a scoped request for a file reverted between event and response
// returns, so tests spell that case by deleting the entry.
interface FileState {
  patch?: string
  binary?: BinaryFileInfo['type']
  untracked?: boolean
  contents?: string
}
let world = new Map<string, FileState>()

// Per-request overrides, keyed off the URL so a test can fail or stall the
// scoped refetch while leaving full reloads working (and vice versa).
let statusFor: (url: string) => number = () => 200
let deferIf: ((url: string) => boolean) | null = null
// Requests parked by `deferIf`, oldest first. `release(patch)` resolves one,
// optionally with a literal patch body that bypasses `world` — that is how a
// test gives two in-flight reads of the same path different content.
let pending: Array<{ url: string; release: (patch?: string) => void }> = []
// URLs whose request was aborted by the hook. The ledger would drop a
// superseded response anyway, so the abort is invisible in `patch` — this is
// the only place it can be observed, and both guards are meant to hold.
let aborted: string[] = []

function abortError() {
  return new DOMException('aborted', 'AbortError')
}

function buildResponse(paths: string[] | null) {
  const keys = paths ?? [...world.keys()]
  const binaryFiles: BinaryFileInfo[] = []
  const untrackedFiles: string[] = []
  const fileContents: FileContentsMap = {}
  const patches: string[] = []
  for (const p of keys) {
    const f = world.get(p)
    if (!f) continue
    if (f.patch) patches.push(f.patch)
    if (f.binary) binaryFiles.push({ path: p, type: f.binary })
    if (f.untracked) untrackedFiles.push(p)
    if (f.contents !== undefined) {
      fileContents[p] = { old: { contents: f.contents }, new: { contents: f.contents } }
    }
  }
  return {
    patch: patches.join('\n'),
    repoName: 'krit',
    branch: 'main',
    customMode: false,
    binaryFiles,
    untrackedFiles,
    fileContents,
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
  pending = []
  aborted = []
  statusFor = () => 200
  deferIf = null
  world = new Map<string, FileState>([
    ['src/a.rs', { patch: A }],
    ['src/b.rs', { patch: B }],
  ])
  FakeEventSource.last = null
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      requested.push(url)
      const signal = init?.signal
      signal?.addEventListener('abort', () => aborted.push(url))
      let override: string | undefined
      if (deferIf?.(url)) {
        const parked = new Promise<string | undefined>((resolve) => {
          pending.push({ url, release: resolve })
        })
        // A parked request must still lose to its own abort, or the hook's
        // abort-on-full-reload guard has nothing to guard against here.
        const aborted = new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(abortError()))
        })
        override = await Promise.race([parked, aborted])
      }
      if (signal?.aborted) throw abortError()
      const status = statusFor(url)
      if (status !== 200) return { ok: false, status, json: async () => ({}) }
      const paths = fetchedPathsFor(url)
      const body = buildResponse(paths.length > 0 ? paths : null)
      return { ok: true, json: async () => (override === undefined ? body : { ...body, patch: override }) }
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

describe('DiffRequestLedger', () => {
  it('lets a scoped response write only the paths nothing newer has claimed', () => {
    const ledger = new DiffRequestLedger()
    const first = ledger.beginPaths(['src/a.rs', 'src/b.rs'])
    const second = ledger.beginPaths(['src/a.rs'])
    // The overlap belongs to the later request even though it started second;
    // the rest of the older batch is still the older request's to deliver.
    expect(ledger.currentPaths(first, ['src/a.rs', 'src/b.rs'])).toEqual(['src/b.rs'])
    expect(ledger.currentPaths(second, ['src/a.rs'])).toEqual(['src/a.rs'])
  })

  it('drops a scoped response entirely once a full reload has started', () => {
    const ledger = new DiffRequestLedger()
    const scoped = ledger.beginPaths(['src/a.rs'])
    ledger.beginFull()
    expect(ledger.currentPaths(scoped, ['src/a.rs'])).toEqual([])
  })

  it('drops a full reload superseded by anything that started after it', () => {
    const ledger = new DiffRequestLedger()
    const full = ledger.beginFull()
    expect(ledger.isCurrentFull(full)).toBe(true)
    ledger.beginPaths(['src/a.rs'])
    expect(ledger.isCurrentFull(full)).toBe(false)
  })

  it('keeps a scoped request current across an unrelated path being claimed', () => {
    const ledger = new DiffRequestLedger()
    const mine = ledger.beginPaths(['src/a.rs'])
    ledger.beginPaths(['src/b.rs'])
    expect(ledger.currentPaths(mine, ['src/a.rs'])).toEqual(['src/a.rs'])
  })
})

describe('useDiff — files-changed and live editors', () => {
  it('spares an editing file from an ultra-mode batch and applies the rest', async () => {
    // ultra applies everything it hears; a live editor is the one exception,
    // because the refetch replaces the document being typed in.
    const { result } = renderUseDiff({
      refreshMode: 'ultra',
      editingFiles: new Set(['src/a.rs']),
    })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    requested = []

    act(() => FakeEventSource.last!.emit({ type: 'files-changed', paths: ['src/a.rs', 'src/b.rs'] }))

    await waitFor(() => expect(result.current.staleFiles.has('src/a.rs')).toBe(true))
    expect(requested.length).toBe(1)
    expect(fetchedPathsFor(requested[0])).toEqual(['src/b.rs'])
  })

  it('still applies the whole batch in ultra mode when nothing is being edited', async () => {
    const { result } = renderUseDiff({ refreshMode: 'ultra' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    requested = []

    act(() => FakeEventSource.last!.emit({ type: 'files-changed', paths: ['src/a.rs', 'src/b.rs'] }))

    await waitFor(() => expect(requested.length).toBe(1))
    expect(fetchedPathsFor(requested[0])).toEqual(['src/a.rs', 'src/b.rs'])
    expect(result.current.staleFiles.size).toBe(0)
  })
})

describe('useDiff — out-of-order responses', () => {
  it('ignores an older refetch of a path that resolves after a newer one', async () => {
    // The burst case the batching exists for: two reads of one file in flight,
    // and HTTP puts no order on which lands first. If the older read wins, the
    // diff settles on content that is already gone and nothing corrects it.
    const { result } = renderUseDiff({ refreshMode: 'ultra' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    deferIf = (url) => fetchedPathsFor(url).length > 0

    act(() => FakeEventSource.last!.emit({ type: 'file-written', path: 'src/a.rs' }))
    await waitFor(() => expect(pending.length).toBe(1))
    act(() => FakeEventSource.last!.emit({ type: 'file-written', path: 'src/a.rs' }))
    await waitFor(() => expect(pending.length).toBe(2))

    const newer = fragment('src/a.rs', '+newest')
    const older = fragment('src/a.rs', '+stale')
    await act(async () => {
      pending[1].release(newer)
      pending[0].release(older)
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current.patch).toContain('+newest'))
    expect(result.current.patch).not.toContain('+stale')
  })
})

describe('diffHeaderPath', () => {
  it('takes the b/-side of a path that itself contains " b/"', () => {
    // git writes both sides verbatim, so `foo b/bar.rs` produces a header with
    // three " b/" occurrences and only the length-symmetric split is right.
    const line = 'diff --git a/foo b/bar.rs b/foo b/bar.rs'
    expect(diffHeaderPath(line)).toBe('foo b/bar.rs')
  })

  it('falls back to the first " b/" for a rename, whose sides differ', () => {
    expect(diffHeaderPath('diff --git a/old/name.rs b/new/name.rs')).toBe('new/name.rs')
  })

  it('returns null for a line that is not a diff header', () => {
    expect(diffHeaderPath('+++ b/src/a.rs')).toBeNull()
  })
})

describe('patch splitting with awkward paths', () => {
  const awkward = 'foo b/bar.rs'

  it('keys a fragment on the whole path when the path contains " b/"', () => {
    const map = splitFilePatches(fragment(awkward))
    expect([...map.keys()]).toEqual([awkward])
  })

  it('replaces such a file in place instead of appending a duplicate', () => {
    // Mis-keying the header path makes the fragment invisible to the splice
    // scan, so the refetched copy lands at the end and the file renders twice.
    const full = [A, fragment(awkward)].join('\n')
    const updated = fragment(awkward, '+edited')
    const out = spliceFilePatches(full, new Map([[awkward, updated]]))
    expect(out).toBe([A, updated].join('\n'))
  })
})

describe('useDiff — the SSE subscription itself', () => {
  it('subscribes to /api/events as a UI client', async () => {
    // role=ui is load-bearing: the server treats an unstated role as a CLI
    // client, which is also the role whose stream filters out the very
    // file-changed/files-changed frames this hook exists to consume.
    const { result } = renderUseDiff()
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    expect(FakeEventSource.last!.url).toBe('/api/events?role=ui')
  })

  it('ignores frames delivered under any event type but `message`', async () => {
    const { result } = renderUseDiff({ refreshMode: 'ultra' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    requested = []

    act(() => FakeEventSource.last!.emit({ type: 'file-written', path: 'src/a.rs' }, 'bogus-type'))

    await act(async () => { await Promise.resolve() })
    expect(requested).toEqual([])
    expect(result.current.staleFiles.size).toBe(0)
  })
})

describe('useDiff — per-path metadata merge', () => {
  it('replaces binary/untracked/contents for refetched paths and leaves others alone', async () => {
    world.set('src/a.rs', { patch: A, untracked: true, contents: 'before' })
    world.set('src/b.rs', { patch: B, binary: 'changed' })
    const { result } = renderUseDiff({ refreshMode: 'ultra' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    expect(result.current.untrackedFiles).toEqual(['src/a.rs'])

    // a.rs gets staged and turns binary; b.rs is untouched by this refetch.
    world.set('src/a.rs', { patch: A, binary: 'changed', contents: 'after' })
    act(() => FakeEventSource.last!.emit({ type: 'file-written', path: 'src/a.rs' }))

    await waitFor(() => expect(result.current.untrackedFiles).toEqual([]))
    expect(result.current.binaryFiles.map((b) => b.path).sort()).toEqual(['src/a.rs', 'src/b.rs'])
    // fileContents seeds the editor modal and its If-Match base, so a stale
    // entry here overwrites someone else's work rather than mis-rendering.
    expect(result.current.fileContents['src/a.rs'].new).toEqual({ contents: 'after' })
  })

  it('drops a requested path the response has nothing for', async () => {
    world.set('src/a.rs', { patch: A, contents: 'before' })
    const { result } = renderUseDiff({ refreshMode: 'ultra' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    expect(result.current.patch).toContain('a/src/a.rs')

    // Reverted between the watcher event and the request: the server answers
    // with no fragment at all for it.
    world.delete('src/a.rs')
    act(() => FakeEventSource.last!.emit({ type: 'file-written', path: 'src/a.rs' }))

    await waitFor(() => expect(result.current.patch).not.toContain('a/src/a.rs'))
    expect(result.current.patch).toContain('a/src/b.rs')
    expect(result.current.fileContents['src/a.rs']).toBeUndefined()
  })
})

describe('useDiff — failed requests', () => {
  it('surfaces a failed initial load instead of rendering an empty diff', async () => {
    statusFor = () => 500
    const { result } = renderUseDiff()
    await waitFor(() => expect(result.current.error).toBe('HTTP 500'))
    expect(result.current.patch).toBeNull()
  })

  it('leaves the current patch byte-identical when a scoped refetch fails', async () => {
    const { result } = renderUseDiff({ refreshMode: 'ultra' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    const before = result.current.patch
    statusFor = (url) => (fetchedPathsFor(url).length > 0 ? 500 : 200)

    // The server has newer content; the refetch that would install it fails.
    world.set('src/a.rs', { patch: fragment('src/a.rs', '+newest') })
    act(() => FakeEventSource.last!.emit({ type: 'file-written', path: 'src/a.rs' }))

    await waitFor(() => expect(result.current.error).toBe('HTTP 500'))
    expect(result.current.patch).toBe(before)
  })
})

describe('useDiff — a full reload against scoped requests', () => {
  it('aborts the scoped refetches a full reload subsumes', async () => {
    const { result } = renderUseDiff({ refreshMode: 'ultra' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    deferIf = (url) => fetchedPathsFor(url).length > 0

    act(() => FakeEventSource.last!.emit({ type: 'file-written', path: 'src/a.rs' }))
    await waitFor(() => expect(pending.length).toBe(1))
    const scopedUrl = pending[0].url

    await act(async () => {
      await result.current.reload()
    })
    expect(aborted).toEqual([scopedUrl])

    // And releasing it afterwards is inert: an aborted read must not write,
    // and must not report its own cancellation as an error to the user.
    await act(async () => {
      pending[0].release(fragment('src/a.rs', '+from-aborted-read'))
      await Promise.resolve()
    })
    expect(result.current.patch).not.toContain('+from-aborted-read')
    expect(result.current.error).toBeNull()
  })

  it('does not let a slow full reload overwrite a newer scoped response', async () => {
    const { result } = renderUseDiff({ refreshMode: 'ultra' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    deferIf = (url) => fetchedPathsFor(url).length === 0

    act(() => void result.current.reload())
    await waitFor(() => expect(pending.length).toBe(1))

    world.set('src/a.rs', { patch: fragment('src/a.rs', '+newest') })
    act(() => FakeEventSource.last!.emit({ type: 'file-written', path: 'src/a.rs' }))
    await waitFor(() => expect(result.current.patch).toContain('+newest'))

    await act(async () => {
      pending[0].release([A, B].join('\n'))
      await Promise.resolve()
    })

    expect(result.current.patch).toContain('+newest')
  })
})

describe('useDiff — oversized bursts', () => {
  it('falls back to one unscoped reload past the batch cap', async () => {
    // A rebase/checkout tick naming hundreds of files would otherwise build a
    // request line of hundreds of file= params and be rejected whole.
    const paths = Array.from({ length: 41 }, (_, i) => `src/f${i}.rs`)
    for (const p of paths) world.set(p, { patch: fragment(p) })
    const { result } = renderUseDiff({ refreshMode: 'manual' })
    await waitFor(() => expect(result.current.initialLoading).toBe(false))
    act(() => FakeEventSource.last!.emit({ type: 'files-changed', paths }))
    await waitFor(() => expect(result.current.staleFiles.size).toBe(41))
    requested = []

    act(() => result.current.applyAllStale())

    await waitFor(() => expect(requested.length).toBe(1))
    expect(fetchedPathsFor(requested[0])).toEqual([])
  })
})
