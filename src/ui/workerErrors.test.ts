import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  describeWorkerError,
  reportWorkerError,
  resetWorkerErrors,
  subscribeWorkerErrors,
} from './workerErrors'

beforeEach(() => {
  resetWorkerErrors()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it('quotes the message of an exception inside the worker', () => {
  const event = new ErrorEvent('error', { message: 'boom' })
  expect(describeWorkerError(event)).toContain('boom')
})

it('describes a script that failed to load, which carries no message', () => {
  const text = describeWorkerError(new Event('error'))
  expect(text).toContain('could not start')
  expect(text).not.toContain('without colors')
})

it('reports the same failure once however many workers raise it', () => {
  const seen: string[] = []
  subscribeWorkerErrors((m) => seen.push(m))
  for (let i = 0; i < 8; i++) reportWorkerError(new Event('error'))
  expect(seen).toHaveLength(1)
})

it('still logs every event, so the console keeps the detail', () => {
  for (let i = 0; i < 3; i++) reportWorkerError(new Event('error'))
  expect(console.error).toHaveBeenCalledTimes(3)
})

it('replays a failure that landed before anything subscribed', () => {
  reportWorkerError(new Event('error'))
  const seen: string[] = []
  subscribeWorkerErrors((m) => seen.push(m))
  expect(seen).toHaveLength(1)
})

it('stops delivering after unsubscribe', () => {
  const seen: string[] = []
  const off = subscribeWorkerErrors((m) => seen.push(m))
  off()
  reportWorkerError(new Event('error'))
  expect(seen).toHaveLength(0)
})
