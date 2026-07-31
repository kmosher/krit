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

// The globals krit.app injects into a review window (`withGlobalTauri`), narrowed
// to the one call this file makes. Absent in a browser, which is how the two
// hosts are told apart — there is no user-agent sniffing worth doing here.
interface TauriWindowApi {
  window?: { getCurrentWindow?: () => { close?: () => Promise<void> } }
}

/**
 * Close the review window, and report whether it will actually go.
 *
 * The two hosts differ, and not by degree:
 *
 * - **krit.app** closes for real. The window is a Tauri window framing the local
 *   server, so it can close itself through the app's own API — `close` is
 *   granted to `review-*` windows in the desktop capability, scoped to the
 *   localhost URLs krit frames.
 * - **A browser tab does not close.** `window.close()` only works on a window
 *   opened by script, and a tab `krit` launched from a terminal has no opener —
 *   verified in Chrome, where the call is simply ignored. It is still attempted,
 *   because a reviewer who *did* open krit from a script-opened window gets the
 *   close they asked for; when it is ignored, the caller says so on the page
 *   rather than leaving a finished review looking like it hung.
 *
 * Do not "fix" the browser case with `window.open('', '_self')` first: in Chrome
 * that navigates the page away and still does not close the tab, so the reviewer
 * loses their review and keeps the tab.
 *
 * Either way the server stops, because `endReviewSession` dropped the streams.
 */
export async function closeReviewWindow(): Promise<'closing' | 'stays-open'> {
  try {
    const tauri = (window as unknown as { __TAURI__?: TauriWindowApi }).__TAURI__
    const appWindow = tauri?.window?.getCurrentWindow?.()
    if (appWindow?.close) {
      // Awaited, because the interesting failure is a *rejection*: an app built
      // with the global injected but without `core:window:allow-close` denies
      // the call from a `close` that exists and looks callable. The app bundle
      // and the UI ship separately, so the two can disagree on any machine
      // where only one was rebuilt — and swallowing that rejection would put
      // back exactly the dead frame this is meant to prevent.
      await appWindow.close()
      return 'closing'
    }
  } catch {
    // Denied, or a host that injects a half-built API. Fall through and let the
    // browser path have its turn.
  }
  try {
    window.close()
  } catch {
    // Blocked by the browser; the page simply stays open.
  }
  // `window.closed` does not flip synchronously even when the close is honoured,
  // so this is the pessimistic answer: the caller says the window is the
  // reviewer's to close, and a window that *is* closing takes the message with
  // it.
  return 'stays-open'
}
