import { useEffect, useRef, useState } from 'react'
import type { EndReason } from '../../types'
import { INITIAL_HEALTH, PROBE_INTERVAL_MS, nextHealth, type HealthState } from './serverHealth'

/**
 * Watch the backend, and say when it is gone.
 *
 * `goodbye` is the server's `review-ended` reason as `useReviewState` saw it,
 * or null while it is still running. Everything else this hook learns, it
 * learns by probing — see `serverHealth.ts` for why the probe is the authority
 * and a failed page request is not.
 *
 * The loop is a `setInterval`, and must stay one. Anything driven by
 * `requestAnimationFrame` stops running while the page reports itself hidden,
 * which is the entire time anything is driving krit programmatically — the
 * sessions where a server dying unnoticed costs the most.
 */
export function useServerHealth(goodbye: EndReason | null): HealthState {
  const [health, setHealth] = useState<HealthState>(INITIAL_HEALTH)

  useEffect(() => {
    if (goodbye === null) return
    setHealth((prev) => nextHealth(prev, { kind: 'goodbye', reason: goodbye }))
  }, [goodbye])

  // Held in a ref so the probe's own result can't restart the interval: a
  // dependency on `health` would tear down and re-arm the timer on every
  // transition, and the failure count is what the transitions are counting.
  const healthRef = useRef(health)
  healthRef.current = health

  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      // `fetch` rejects only on a transport failure. An HTTP error — including
      // a 500 — resolves, and counts as the server being alive, because it is.
      let alive: boolean
      try {
        await fetch('/api/settings', { cache: 'no-store' })
        alive = true
      } catch {
        alive = false
      }
      if (cancelled) return
      setHealth((prev) => nextHealth(prev, { kind: alive ? 'probe-ok' : 'probe-failed' }))
    }
    const timer = setInterval(() => void probe(), PROBE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return health
}
