import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeReviewWindow, endReviewSession, onReviewSessionEnd } from './reviewSession'

describe('reviewSession', () => {
  it('runs every registered listener, and stops running them once unsubscribed', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = onReviewSessionEnd(a)
    const offB = onReviewSessionEnd(b)
    endReviewSession()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    endReviewSession()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    offB()
  })

  it('runs the remaining listeners when one throws', () => {
    // The whole point is to get every stream closed. A hook that fails on the
    // way out must not take the others with it and leave the server waiting.
    const boom = vi.fn(() => {
      throw new Error('nope')
    })
    const after = vi.fn()
    const off1 = onReviewSessionEnd(boom)
    const off2 = onReviewSessionEnd(after)
    expect(() => endReviewSession()).not.toThrow()
    expect(after).toHaveBeenCalled()
    off1()
    off2()
  })

  it('survives a listener that unsubscribes itself mid-run', () => {
    const later = vi.fn()
    const off2 = onReviewSessionEnd(later)
    const off1 = onReviewSessionEnd(() => off1())
    endReviewSession()
    expect(later).toHaveBeenCalled()
    off2()
  })

  it('swallows a refused window.close', () => {
    vi.stubGlobal('close', () => {
      throw new Error('blocked')
    })
    expect(() => closeReviewWindow()).not.toThrow()
    vi.unstubAllGlobals()
  })
})

describe('closeReviewWindow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
  })

  it('closes the krit.app window through the app API when it is there', async () => {
    // The desktop window frames the local server as remote content, so this
    // global is the only thing distinguishing the two hosts — there is no
    // user-agent worth sniffing.
    const close = vi.fn(() => Promise.resolve())
    ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {
      window: { getCurrentWindow: () => ({ close }) },
    }
    const browserClose = vi.fn()
    vi.stubGlobal('close', browserClose)
    await expect(closeReviewWindow()).resolves.toBe('closing')
    expect(close).toHaveBeenCalled()
    // window.close() would be a no-op here anyway, but calling both would mean
    // two close paths racing on the one window.
    expect(browserClose).not.toHaveBeenCalled()
  })

  it('reports that a browser tab stays open, because it does', async () => {
    // Chrome ignores close() on a tab no script opened, which is every tab
    // `krit` launches from a terminal. Saying so is what lets the toolbar tell
    // the reviewer to close it rather than leaving a finished review sitting
    // there looking stuck.
    const browserClose = vi.fn()
    vi.stubGlobal('close', browserClose)
    await expect(closeReviewWindow()).resolves.toBe('stays-open')
    expect(browserClose).toHaveBeenCalled()
  })

  it('survives a browser that throws instead of ignoring the call', async () => {
    vi.stubGlobal('close', () => {
      throw new Error('Scripts may not close windows that were not opened by script')
    })
    await expect(closeReviewWindow()).resolves.toBe('stays-open')
  })

  it('falls back to the browser path when the app window refuses to close', async () => {
    // The shape a missing `core:window:allow-close` actually produces: the
    // method is there and callable, and the promise rejects. The app bundle and
    // the UI ship separately, so an app built without the capability is the
    // ordinary skew — and treating that as "closing" leaves the reviewer with a
    // dead window and a label saying the review is done.
    ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {
      window: { getCurrentWindow: () => ({ close: () => Promise.reject(new Error('forbidden')) }) },
    }
    const browserClose = vi.fn()
    vi.stubGlobal('close', browserClose)
    await expect(closeReviewWindow()).resolves.toBe('stays-open')
    expect(browserClose).toHaveBeenCalled()
  })

  it('falls back when the host injects a global it cannot use', async () => {
    // A half-built API: the namespace exists, the accessor throws. Left
    // unguarded this rejects `submitReview` *after* the review was submitted,
    // so the page reports failure for something that succeeded.
    ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {
      window: {
        getCurrentWindow: () => {
          throw new Error('not initialised')
        },
      },
    }
    const browserClose = vi.fn()
    vi.stubGlobal('close', browserClose)
    await expect(closeReviewWindow()).resolves.toBe('stays-open')
    expect(browserClose).toHaveBeenCalled()
  })
})
