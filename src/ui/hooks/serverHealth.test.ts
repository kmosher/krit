import { describe, expect, it } from 'vitest'
import {
  GONE_AFTER_FAILED_PROBES,
  INITIAL_HEALTH,
  isAlarming,
  nextHealth,
  type HealthState,
} from './serverHealth'

/** Feed a run of inputs through the machine, starting from healthy. */
function run(...inputs: Parameters<typeof nextHealth>[1][]): HealthState {
  return inputs.reduce(nextHealth, INITIAL_HEALTH)
}

const failed = { kind: 'probe-failed' } as const
const ok = { kind: 'probe-ok' } as const

describe('nextHealth', () => {
  it('stays quiet through fewer failures than the threshold', () => {
    const state = run(...Array(GONE_AFTER_FAILED_PROBES - 1).fill(failed))
    expect(state.status).toBe('degraded')
    expect(isAlarming(state)).toBe(false)
  })

  it('calls it gone on the threshold failure, not before', () => {
    expect(run(...Array(GONE_AFTER_FAILED_PROBES).fill(failed)).status).toBe('gone')
  })

  it('requires the failures to be consecutive', () => {
    // A probe landing in the middle resets the count — otherwise a page open
    // for an hour accumulates unrelated blips into a tombstone.
    const inputs = Array(GONE_AFTER_FAILED_PROBES * 2).fill(failed)
    inputs[GONE_AFTER_FAILED_PROBES - 1] = ok
    expect(run(...inputs.slice(0, GONE_AFTER_FAILED_PROBES + 1)).status).toBe('degraded')
  })

  it('recovers to ok from gone when the server answers again', () => {
    const dead = run(...Array(GONE_AFTER_FAILED_PROBES).fill(failed))
    expect(nextHealth(dead, ok)).toEqual(INITIAL_HEALTH)
  })

  it('takes the goodbye immediately, without waiting for a probe to fail', () => {
    const state = nextHealth(INITIAL_HEALTH, { kind: 'goodbye', reason: 'signal' })
    expect(state.status).toBe('ended')
    expect(state.reason).toBe('signal')
  })

  it('keeps the named ending when the probes that follow it fail', () => {
    // The server stops answering ~300ms after saying goodbye, so this run is
    // the normal one. Downgrading to `gone` would trade "krit was terminated"
    // for "not answering" a few seconds after the reviewer read the first.
    let state = nextHealth(INITIAL_HEALTH, { kind: 'goodbye', reason: 'signal' })
    for (let i = 0; i < GONE_AFTER_FAILED_PROBES * 2; i++) state = nextHealth(state, failed)
    expect(state.status).toBe('ended')
    expect(state.reason).toBe('signal')
  })

  it('recovers from ended too, for a server restarted on the same port', () => {
    const ended = nextHealth(INITIAL_HEALTH, { kind: 'goodbye', reason: 'idle' })
    expect(nextHealth(ended, ok)).toEqual(INITIAL_HEALTH)
  })
})

describe('isAlarming', () => {
  it('says nothing about a review the reviewer finished', () => {
    // Done reviewing already closes the window (or explains why it can't).
    // A red banner on top of that reports success as a failure.
    expect(isAlarming(nextHealth(INITIAL_HEALTH, { kind: 'goodbye', reason: 'submitted' }))).toBe(
      false,
    )
  })

  it('alarms on every ending the reviewer did not ask for', () => {
    for (const reason of ['idle', 'signal', 'no-browser'] as const) {
      expect(isAlarming(nextHealth(INITIAL_HEALTH, { kind: 'goodbye', reason }))).toBe(true)
    }
  })

  it('does not alarm while healthy or merely degraded', () => {
    expect(isAlarming(INITIAL_HEALTH)).toBe(false)
    expect(isAlarming(run(failed))).toBe(false)
  })
})
