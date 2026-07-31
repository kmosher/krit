import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GONE_AFTER_FAILED_PROBES, PROBE_INTERVAL_MS } from './serverHealth'
import { useServerHealth } from './useServerHealth'

/** Advance past `n` probe ticks and let each probe's promise settle. */
async function probes(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      vi.advanceTimersByTime(PROBE_INTERVAL_MS)
      // The probe awaits fetch, so the state update lands a microtask later.
      await vi.advanceTimersByTimeAsync(0)
    })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useServerHealth', () => {
  it('treats an HTTP error as a live server', async () => {
    // The distinction the whole feature rests on: a 500 means krit is there
    // and answering badly, which is the error strip's problem, not a
    // tombstone's. `fetch` resolves for it, so the probe must not look at
    // `res.ok` — and this test fails if someone "tightens" it to.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))
    const { result } = renderHook(() => useServerHealth(null))
    await probes(GONE_AFTER_FAILED_PROBES + 1)
    expect(result.current.status).toBe('ok')
  })

  it('reaches gone once enough probes fail to connect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const { result } = renderHook(() => useServerHealth(null))
    await probes(GONE_AFTER_FAILED_PROBES - 1)
    expect(result.current.status).toBe('degraded')
    await probes(1)
    expect(result.current.status).toBe('gone')
  })

  it('reports a goodbye before any probe has had a chance to fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const { result } = renderHook(({ reason }) => useServerHealth(reason), {
      initialProps: { reason: null as 'signal' | null },
    })
    expect(result.current.status).toBe('ok')
    // No timer advance at all: the point of the goodbye is that it does not
    // cost the reviewer the probe budget.
    const { result: withGoodbye } = renderHook(() => useServerHealth('signal'))
    expect(withGoodbye.current.status).toBe('ended')
    expect(withGoodbye.current.reason).toBe('signal')
    expect(result.current.status).toBe('ok')
  })

  it('stops probing once unmounted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = renderHook(() => useServerHealth(null))
    await probes(1)
    const afterOne = fetchMock.mock.calls.length
    expect(afterOne).toBeGreaterThan(0) // else the assertion below is vacuous
    unmount()
    await probes(3)
    expect(fetchMock.mock.calls.length).toBe(afterOne)
  })
})
