import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useReviewState, submitReview } from './useReviewState'

// happy-dom has no EventSource. This stand-in assigns through the `onmessage`/
// `onerror` properties the hook actually sets, so a switch to addEventListener
// (or a rename of either handler) leaves the frames undelivered and the tests
// red rather than silently passing.
class FakeEventSource {
  static last: FakeEventSource | null = null
  static opened: string[] = []
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.last = this
    FakeEventSource.opened.push(url)
  }
  close() {
    this.closed = true
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
  emitRaw(data: string) {
    this.onmessage?.({ data })
  }
}

beforeEach(() => {
  FakeEventSource.last = null
  FakeEventSource.opened = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useReviewState', () => {
  it('starts at zero with no submit, so the Submit button is disabled before any frame', () => {
    const { result } = renderHook(() => useReviewState())
    expect(result.current).toEqual({ watcherCount: 0, uiCount: 0, agentCount: 0, submittedAt: null })
  })

  it('identifies itself as a browser subscriber', () => {
    // Without role=ui the server files this subscriber as a CLI client: the
    // review server stops being held open and Done-reviewing never enables.
    renderHook(() => useReviewState())
    expect(FakeEventSource.opened).toEqual(['/api/events?role=ui'])
  })

  it('publishes the census from a state frame', () => {
    const { result } = renderHook(() => useReviewState())
    act(() => FakeEventSource.last!.emit({ type: 'state', watcherCount: 2, uiCount: 1, agentCount: 3 }))
    expect(result.current).toEqual({ watcherCount: 2, uiCount: 1, agentCount: 3, submittedAt: null })
  })

  it('records the submit timestamp without disturbing the counts', () => {
    // The Submit button reads both halves of this state; a submitted frame
    // that reset the census would re-disable the button it just satisfied.
    const { result } = renderHook(() => useReviewState())
    act(() => FakeEventSource.last!.emit({ type: 'state', watcherCount: 2, uiCount: 1, agentCount: 0 }))
    act(() => FakeEventSource.last!.emit({ type: 'submitted', timestamp: 1234 }))
    expect(result.current).toEqual({ watcherCount: 2, uiCount: 1, agentCount: 0, submittedAt: 1234 })
  })

  it('keeps the submit timestamp when a later census arrives', () => {
    // A watcher disconnecting after Submit broadcasts a fresh state frame;
    // losing submittedAt there would make the page forget the review ended.
    const { result } = renderHook(() => useReviewState())
    act(() => FakeEventSource.last!.emit({ type: 'submitted', timestamp: 99 }))
    act(() => FakeEventSource.last!.emit({ type: 'state', watcherCount: 0, uiCount: 1, agentCount: 0 }))
    expect(result.current.submittedAt).toBe(99)
    expect(result.current.watcherCount).toBe(0)
  })

  it('takes the newest census when frames arrive back to back', () => {
    const { result } = renderHook(() => useReviewState())
    act(() => {
      FakeEventSource.last!.emit({ type: 'state', watcherCount: 1, uiCount: 1, agentCount: 0 })
      FakeEventSource.last!.emit({ type: 'state', watcherCount: 0, uiCount: 2, agentCount: 1 })
    })
    expect(result.current).toEqual({ watcherCount: 0, uiCount: 2, agentCount: 1, submittedAt: null })
  })

  it('ignores frames owned by other consumers', () => {
    // The SSE stream carries everything; useDiff and useComments own most of
    // it. Reacting here would mean a file save could move the Submit gate.
    const { result } = renderHook(() => useReviewState())
    act(() => FakeEventSource.last!.emit({ type: 'state', watcherCount: 3, uiCount: 1, agentCount: 0 }))
    const before = result.current
    act(() => {
      FakeEventSource.last!.emit({ type: 'clients', browsers: 2 })
      FakeEventSource.last!.emit({ type: 'files-changed', paths: ['a.rs'] })
      FakeEventSource.last!.emit({ type: 'file-written', path: null })
      FakeEventSource.last!.emit({ type: 'review-ended', reason: 'done' })
    })
    expect(result.current).toEqual(before)
  })

  it('survives a malformed frame and keeps serving later ones', () => {
    // A parse throw inside onmessage would tear down the handler for the rest
    // of the connection — the counts would freeze at whatever they last were
    // with no visible error.
    const { result } = renderHook(() => useReviewState())
    act(() => FakeEventSource.last!.emitRaw('not json{'))
    act(() => FakeEventSource.last!.emit({ type: 'state', watcherCount: 5, uiCount: 1, agentCount: 0 }))
    expect(result.current.watcherCount).toBe(5)
  })

  it('shrugs off a transient connection error', () => {
    // EventSource reconnects on its own; throwing (or resetting state) here
    // would turn every network blip into a broken page.
    const { result } = renderHook(() => useReviewState())
    act(() => FakeEventSource.last!.emit({ type: 'state', watcherCount: 4, uiCount: 1, agentCount: 0 }))
    act(() => FakeEventSource.last!.onerror?.({}))
    expect(result.current.watcherCount).toBe(4)
  })

  it('closes the stream on unmount', () => {
    // Every leaked EventSource counts as another subscriber server-side, so a
    // missing close inflates uiCount and keeps the review server alive forever.
    const { unmount } = renderHook(() => useReviewState())
    const es = FakeEventSource.last!
    unmount()
    expect(es.closed).toBe(true)
  })

  it('opens exactly one stream across re-renders', () => {
    // The effect has an empty dep list on purpose: re-subscribing per render
    // would churn the server's census.
    const { rerender } = renderHook(() => useReviewState())
    rerender()
    rerender()
    expect(FakeEventSource.opened).toHaveLength(1)
  })
})

describe('submitReview', () => {
  it('POSTs to /api/submit with the concluding notes', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) }))
    vi.stubGlobal('fetch', fetchMock)
    await submitReview('looks good')
    expect(fetchMock).toHaveBeenCalledWith('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'looks good' }),
    })
  })

  it('still POSTs a body when there are no notes', async () => {
    // One request shape, always. The server reads blank notes as none, so the
    // caller does not have to decide whether to send a body at all.
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) }))
    vi.stubGlobal('fetch', fetchMock)
    await submitReview()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/submit',
      expect.objectContaining({ body: JSON.stringify({ summary: '' }) }),
    )
  })

  it('drops this tab’s event stream, so the server sees the browser leave', async () => {
    // This is the mechanism that stops the server on Done reviewing. If the
    // stream stays open the ui count never reaches zero and the process
    // lingers until the idle grace period expires -- the exact wait the
    // button is supposed to skip.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
    renderHook(() => useReviewState())
    const es = FakeEventSource.last!
    expect(es.closed).toBe(false)
    await act(async () => {
      await submitReview()
    })
    expect(es.closed).toBe(true)
  })

  it('tears down only after the POST has been answered', async () => {
    // Closing first would race the server: the queued comments are posted and
    // `submitted` is broadcast by that request, and a shutdown triggered by
    // the disconnect must not overtake it.
    let resolvePost!: (v: unknown) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((r) => (resolvePost = r))),
    )
    renderHook(() => useReviewState())
    const es = FakeEventSource.last!
    const pending = submitReview()
    await Promise.resolve()
    expect(es.closed, 'the stream must outlive the in-flight POST').toBe(false)
    resolvePost({})
    await act(async () => {
      await pending
    })
    expect(es.closed).toBe(true)
  })

  it('asks the window to close, and survives a browser that refuses', async () => {
    // A tab the script didn't open ignores window.close(); some environments
    // throw outright. Either way the teardown above has already happened, so
    // the refusal must not propagate out of submitReview.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
    const close = vi.fn(() => {
      throw new Error('Scripts may not close windows that were not opened by script')
    })
    vi.stubGlobal('close', close)
    renderHook(() => useReviewState())
    const es = FakeEventSource.last!
    await expect(submitReview()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalled()
    expect(es.closed).toBe(true)
  })
})
