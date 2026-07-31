import { useEffect, useState } from 'react'
import { isAlarming, type HealthState } from '../hooks/serverHealth'

/**
 * The backend is gone and this page can no longer save anything.
 *
 * Loud on purpose — the failure it reports is silent everywhere else, and every
 * subtler treatment it might have had (a strip in the stack, a dot in the
 * toolbar) already exists for conditions the reviewer can recover from. This
 * one they cannot.
 *
 * Dismissible anyway, for two reasons that both end with the reviewer wanting
 * the diff back: the server may be coming back under them (`krit` restarted in
 * the terminal, which the probe will notice on its own), and this detection can
 * be wrong in a way the reviewer can see and we can't. A banner that cannot be
 * closed would make our bug their dead end.
 */
export function ServerGoneBanner({
  health,
  onCopyComments,
}: {
  health: HealthState
  /**
   * Salvage. Repeated from the toolbar because the banner covers the toolbar
   * once the page is scrolled, and because this is the moment a reviewer most
   * needs their comments out of a page that can no longer store them.
   * Client-side, so it still works with nothing listening.
   */
  onCopyComments?: () => void
}): React.ReactElement | null {
  const [dismissed, setDismissed] = useState(false)

  // Dismissal covers the condition on screen, not the banner forever: a page
  // that recovers and dies again is telling the reviewer something new.
  useEffect(() => {
    setDismissed(false)
  }, [health.status])

  if (!isAlarming(health) || dismissed) return null

  const { headline, detail } = message(health)
  return (
    <div className="server-gone" role="alert">
      <div className="server-gone-text">
        <strong>{headline}</strong>
        <span>{detail}</span>
      </div>
      {onCopyComments && (
        <button className="btn btn-secondary btn-sm" onClick={onCopyComments}>
          Copy comments
        </button>
      )}
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => setDismissed(true)}
        // Named for what it does to the banner, not to the problem. "Dismiss"
        // next to a tombstone reads like an acknowledgement that fixed it.
        aria-label="Hide this warning"
      >
        Hide
      </button>
    </div>
  )
}

function message(health: HealthState): { headline: string; detail: string } {
  const dead = 'Nothing you type here is being saved — comments, replies and edits will all fail.'
  if (health.status === 'ended') {
    switch (health.reason) {
      case 'idle':
        return {
          headline: 'The krit server shut down — it was left idle.',
          detail: `${dead} Start it again from your terminal to keep reviewing.`,
        }
      case 'signal':
        return {
          headline: 'The krit server was terminated.',
          detail: `${dead} Start it again from your terminal to keep reviewing.`,
        }
      default:
        return {
          headline: 'The krit server has exited.',
          detail: `${dead} Start it again from your terminal to keep reviewing.`,
        }
    }
  }
  // `gone`: no goodbye arrived, so it did not exit on purpose.
  return {
    headline: 'The krit server is not answering.',
    detail: `${dead} It may have crashed; this page reconnects on its own if it comes back.`,
  }
}
