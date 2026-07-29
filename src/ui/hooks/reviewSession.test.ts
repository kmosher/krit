import { describe, expect, it, vi } from 'vitest'
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
