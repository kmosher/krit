// Ending the review is a whole-page action, but the things that have to stop
// are scattered across hooks. Rather than thread a prop through every one,
// they register here and `endReviewSession` runs the lot.
//
// This fires only in the tab whose Done reviewing button was clicked. Other
// tabs learn the review was submitted over SSE and keep their streams — the
// server waits for the *last* browser to leave, and closing someone else's
// live page out from under them is not this button's business.

type Listener = () => void

const listeners = new Set<Listener>()

/** Returns an unsubscribe, so callers can hand it straight to useEffect. */
export function onReviewSessionEnd(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function endReviewSession(): void {
  // Copied first: a listener that unsubscribes itself while running would
  // otherwise mutate the set mid-iteration.
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      // One hook failing to tear down must not strand the others, and there
      // is nothing useful to do about it on the way out.
    }
  }
}

/**
 * Best-effort close of the tab or the krit.app window.
 *
 * `window.close()` is a no-op in a tab the script didn't open, which is the
 * common case for `krit` launched from a terminal — so this is a nicety, not
 * the mechanism. The server stops because `endReviewSession` dropped the SSE
 * streams and the browser count went to zero, whether or not the window
 * actually goes away.
 */
export function closeReviewWindow(): void {
  try {
    window.close()
  } catch {
    // Blocked by the browser; the page simply stays open.
  }
}
