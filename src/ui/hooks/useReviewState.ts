import { useEffect, useState } from 'react'
import type { KritEvent } from '../../types'
import { closeReviewWindow, endReviewSession, onReviewSessionEnd } from './reviewSession'

export interface ReviewState {
  /** Number of CLI watchers currently subscribed (i.e. processes ready to react to Submit). */
  watcherCount: number
  /** Number of UI subscribers — this client is one of them. */
  uiCount: number
  /** Number of agent subscribers connected over the native /api/events-ws endpoint. */
  agentCount: number
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
    agentCount: 0,
    submittedAt: null,
  })

  useEffect(() => {
    // `role=ui` is what makes this subscriber count as a browser: the server
    // defaults an unstated role to a CLI client, which neither holds the
    // review server alive nor gates the Done-reviewing button. (Two
    // EventSources per tab is the v1 client-count contract, not a leak.)
    const es = new EventSource('/api/events?role=ui')
    es.onmessage = (e) => {
      let event: KritEvent
      try {
        // Typed against the wire union so a Rust-side rename fails `tsc`
        // rather than quietly freezing the counts at zero.
        event = JSON.parse(e.data) as KritEvent
      } catch {
        return
      }
      switch (event.type) {
        case 'state':
          setState((prev) => ({
            ...prev,
            watcherCount: event.watcherCount,
            uiCount: event.uiCount,
            agentCount: event.agentCount,
          }))
          return
        case 'submitted':
          setState((prev) => ({ ...prev, submittedAt: event.timestamp }))
          return
        // Everything else belongs to another consumer (useDiff, useComments).
        // Enumerated rather than defaulted so a new Rust variant has to be
        // considered here; not every variant reaches every stream.
        case 'clients':
        case 'comment-added':
        case 'comment-updated':
        case 'reply-added':
        case 'file-changed':
        case 'files-changed':
        case 'file-written':
        case 'user-edit':
        case 'review-ended':
          return
      }
    }
    es.onerror = () => {
      // The browser auto-reconnects EventSources; nothing to do here besides
      // ignoring the transient error.
    }
    const unsubscribe = onReviewSessionEnd(() => es.close())
    return () => {
      unsubscribe()
      es.close()
    }
  }, [])

  return state
}

/**
 * Done reviewing. The POST is awaited before anything is torn down, so the
 * server has already posted the queued comments and broadcast `submitted` when this
 * tab's streams go; the disconnect that follows is what lets it shut down at
 * once if this was the last browser.
 *
 * Returns what became of the window: krit.app closes, a browser tab cannot
 * (see `closeReviewWindow`), and the caller tells the reviewer which happened.
 */
export async function submitReview(summary = ''): Promise<'closing' | 'stays-open'> {
  // The body is always sent, even empty: one request shape is easier to reason
  // about than two, and the server treats blank notes as none.
  await fetch('/api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ summary }),
  })
  endReviewSession()
  return await closeReviewWindow()
}
