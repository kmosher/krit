// Is the backend still there?
//
// A review page that has lost its server is not a page with a failed request on
// it — nothing typed into it will ever be saved, and the previous treatment (a
// load-failure strip, indistinguishable from a 500) let a reviewer keep working
// into a void. This decides which of those it is.
//
// The discrimination is a *probe*, not an inference from a failed read. A
// server answering `500` on one route is alive, and the error strip is the
// right response to that; only a request that fails to connect at all is
// evidence of a corpse. `fetch` draws exactly that line for us — an HTTP error
// resolves, a transport failure rejects — so the probe reads the network layer
// and nothing else. (`/api/settings` is the same route `krit-tui` probes with,
// for the same reason.)
//
// The other input is the server's own goodbye. `review-ended` names the ending,
// which is both faster than waiting out the probes and the only way to tell a
// finished review from a killed one — the socket dies identically either way.

import type { EndReason } from '../../types'

export type HealthStatus =
  /** Probes are landing. */
  | 'ok'
  /** A probe failed, but not enough of them to call it. Deliberately silent. */
  | 'degraded'
  /** Nothing is listening. Nothing this page does from here is saved. */
  | 'gone'
  /** The server said goodbye and named the reason. */
  | 'ended'

export interface HealthState {
  status: HealthStatus
  /** Set only for `ended` — the rest have no reason to give. */
  reason: EndReason | null
  /** Consecutive failed probes. Exposed for the tests, not for the UI. */
  failures: number
}

export type HealthInput =
  | { kind: 'probe-ok' }
  | { kind: 'probe-failed' }
  | { kind: 'goodbye'; reason: EndReason }

export const INITIAL_HEALTH: HealthState = { status: 'ok', reason: null, failures: 0 }

/**
 * How long between probes, and how many must fail before the page says the
 * server is gone.
 *
 * The product (~6s) is the *crash* budget only — a server that exits normally
 * says goodbye and the banner is instant. It has to clear a page refresh (the
 * same event the server's own 5s idle window is sized for), or reloading the
 * review would flash a tombstone at a reviewer whose backend is fine.
 */
export const PROBE_INTERVAL_MS = 2000
export const GONE_AFTER_FAILED_PROBES = 3

export function nextHealth(prev: HealthState, input: HealthInput): HealthState {
  switch (input.kind) {
    case 'goodbye':
      // Immediate and without waiting for a probe: the server broadcasts this
      // ~300ms before it stops answering, so the probes would only confirm it
      // slower and with less information.
      return { status: 'ended', reason: input.reason, failures: 0 }
    case 'probe-ok':
      // Recovery from every state, `ended` included. A reviewer who restarts
      // `krit` on the same port has a live page again, and refusing to notice
      // would leave a working review under a tombstone.
      return INITIAL_HEALTH
    case 'probe-failed': {
      // A dead server keeps failing probes; that must not walk `ended` (which
      // knows *why*) back to the generic `gone`.
      if (prev.status === 'ended') return { ...prev, failures: prev.failures + 1 }
      const failures = prev.failures + 1
      return {
        status: failures >= GONE_AFTER_FAILED_PROBES ? 'gone' : 'degraded',
        reason: null,
        failures,
      }
    }
  }
}

/**
 * Whether this state is worth interrupting the reviewer over.
 *
 * `degraded` deliberately shows nothing. A single missed probe is a blip, and a
 * banner that appears and vanishes on its own teaches reviewers to ignore the
 * banner — which is the one thing it cannot afford, since the state it exists
 * to report is the one where ignoring it costs work.
 */
export function isAlarming(state: HealthState): boolean {
  return state.status === 'gone' || (state.status === 'ended' && state.reason !== 'submitted')
}
