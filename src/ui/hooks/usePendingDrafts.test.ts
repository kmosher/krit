import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { fromWire, slotKey, toWire, usePendingDrafts, type DraftLike } from './usePendingDrafts'
import type { PendingDraft } from '../../types'

const draft: DraftLike = {
  itemId: 'src/a.rs',
  side: 'additions',
  startLine: 10,
  endLine: 12,
  body: 'half a thought',
  suggestMode: false,
  suggestionText: '',
  suggestionEdited: false,
}

describe('toWire / fromWire', () => {
  it('round-trips a plain draft', () => {
    expect(fromWire(toWire(draft, 1))).toEqual(draft)
  })

  it('round-trips a character anchor', () => {
    const anchored: DraftLike = {
      ...draft,
      charAnchor: { startColumn: 4, endColumn: 9, selectedText: 'hello' },
    }
    expect(fromWire(toWire(anchored, 1))).toEqual(anchored)
  })

  it('renames itemId to filePath, since CodeView keys items by path', () => {
    expect(toWire(draft, 1).filePath).toBe('src/a.rs')
  })

  it('drops a partial anchor rather than restoring half of one', () => {
    // All three fields or none — a range comment placed with a start column and
    // no end column would anchor somewhere the reviewer never selected.
    const partial = { ...toWire(draft, 1), startColumn: 4 } as PendingDraft
    expect(fromWire(partial).charAnchor).toBeUndefined()
  })

  it('keys a slot by anchor, not identity', () => {
    const retyped: DraftLike = { ...draft, body: 'different text' }
    const moved: DraftLike = { ...draft, startLine: 11 }
    expect(slotKey(draft)).toBe(slotKey(retyped))
    expect(slotKey(draft)).not.toBe(slotKey(moved))
  })
})

describe('usePendingDrafts', () => {
  let puts: PendingDraft[]
  let keepalives: (boolean | undefined)[]
  let deletes: unknown[]
  let stored: PendingDraft[]

  beforeEach(() => {
    vi.useFakeTimers()
    puts = []
    keepalives = []
    deletes = []
    stored = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: { method?: string; body?: string; keepalive?: boolean }) => {
        if (init?.method === 'PUT') {
          puts.push(JSON.parse(init.body ?? '{}'))
          keepalives.push(init.keepalive)
        } else if (String(url).endsWith('/delete')) deletes.push(JSON.parse(init?.body ?? '{}'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(stored) })
      }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('collapses a burst of typing into one write', async () => {
    // The form calls this on every keystroke by design; one request per
    // character would be a request per character.
    const { result } = renderHook(() => usePendingDrafts())
    act(() => {
      result.current.persist({ ...draft, body: 'h' })
      result.current.persist({ ...draft, body: 'ha' })
      result.current.persist({ ...draft, body: 'half' })
    })
    expect(puts).toHaveLength(0)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toBe('half')
  })

  it('debounces per slot, so two open forms do not cancel each other', async () => {
    const { result } = renderHook(() => usePendingDrafts())
    act(() => {
      result.current.persist({ ...draft, body: 'first form' })
      result.current.persist({ ...draft, startLine: 99, endLine: 99, body: 'second form' })
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(puts.map((p) => p.body).sort()).toEqual(['first form', 'second form'])
  })

  it('cancels a queued write when the draft is forgotten', async () => {
    // Submit or discard races the debounce. If the timer wins, the draft the
    // reviewer just dealt with reappears on their next load.
    const { result } = renderHook(() => usePendingDrafts())
    act(() => {
      result.current.persist({ ...draft, body: 'about to be submitted' })
      result.current.forget(draft)
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(puts).toHaveLength(0)
    expect(deletes).toEqual([
      { filePath: 'src/a.rs', side: 'additions', startLine: 10, endLine: 12 },
    ])
  })

  it('sends the text as it was when persist was called, not as it later became', async () => {
    // CodeViewWrapper mutates the draft object in place, so holding the
    // reference would send whatever the object had become when the timer fired.
    const live: DraftLike = { ...draft, body: 'original' }
    const { result } = renderHook(() => usePendingDrafts())
    act(() => {
      result.current.persist(live)
    })
    live.body = 'mutated after the fact'
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(puts[0].body).toBe('original')
  })

  // waitFor polls on timers, so the two hydration tests need real ones. They
  // assert on a one-shot read, not on the debounce, so nothing is lost.
  it('restores what was being typed', async () => {
    vi.useRealTimers()
    stored = [toWire({ ...draft, body: 'from last session' }, 5)]
    const { result } = renderHook(() => usePendingDrafts())
    await waitFor(() => expect(result.current.restored).not.toBeNull())
    expect(result.current.restored).toEqual([fromWire(stored[0])])
  })

  it('restores nothing rather than failing when the read fails', async () => {
    vi.useRealTimers()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('server gone'))))
    const { result } = renderHook(() => usePendingDrafts())
    await waitFor(() => expect(result.current.restored).toEqual([]))
  })

  it('flushes a queued write when the component leaves the tree', async () => {
    const { result, unmount } = renderHook(() => usePendingDrafts())
    act(() => {
      result.current.persist({ ...draft, body: 'typed then closed' })
    })
    expect(puts).toHaveLength(0)
    unmount()
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toBe('typed then closed')
  })

  it('flushes a queued write on pagehide, because a reload is not an unmount', async () => {
    // Verified in Chromium, where the earlier unmount-only version lost the
    // last keystrokes before a reload: tearing down the document does not run
    // React cleanup, so the debounce timer just dies with the page. A reload is
    // the case this whole feature exists for.
    const { result } = renderHook(() => usePendingDrafts())
    act(() => {
      result.current.persist({ ...draft, body: 'typed then reloaded' })
    })
    expect(puts).toHaveLength(0)
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toBe('typed then reloaded')
    // Without keepalive the request is cancelled along with the document it was
    // issued from, which is the whole failure mode this path is here to avoid.
    expect(keepalives).toEqual([true])
  })

  it('does not re-send on pagehide when nothing is queued', async () => {
    renderHook(() => usePendingDrafts())
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(puts).toHaveLength(0)
  })
})
