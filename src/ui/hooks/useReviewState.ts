import { useEffect, useState } from 'react'

export interface ReviewState {
  /** Number of CLI watchers currently subscribed (i.e. processes ready to react to Submit). */
  watcherCount: number
  /** Number of UI subscribers — this client is one of them. */
  uiCount: number
  /** Timestamp of the most recent Submit click this page has seen, or null. */
  submittedAt: number | null
}

/**
 * Subscribes to the server's SSE event stream and exposes the live review
 * state to the UI. The Submit button reads `watcherCount` and `submittedAt`
 * from here to decide whether it's clickable.
 */
export function useReviewState(): ReviewState {
  const [state, setState] = useState<ReviewState>({
    watcherCount: 0,
    uiCount: 0,
    submittedAt: null,
  })

  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onmessage = (e) => {
      let msg: { type?: string; watcherCount?: number; uiCount?: number; timestamp?: number }
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (msg.type === 'state') {
        setState((prev) => ({
          ...prev,
          watcherCount: msg.watcherCount ?? prev.watcherCount,
          uiCount: msg.uiCount ?? prev.uiCount,
        }))
      } else if (msg.type === 'submitted') {
        setState((prev) => ({ ...prev, submittedAt: msg.timestamp ?? Date.now() }))
      }
    }
    es.onerror = () => {
      // The browser auto-reconnects EventSources; nothing to do here besides
      // ignoring the transient error.
    }
    return () => es.close()
  }, [])

  return state
}

export async function submitReview(): Promise<void> {
  await fetch('/api/submit', { method: 'POST' })
}
