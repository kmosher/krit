// The highlight worker pool is created in main.tsx, above App, so a failure in
// it has no component to report to. Pierre hands the pool's `onWorkerError`
// the raw event instead of logging it; this is the bridge from there to the
// error strips.
//
// Messages are replayed to a late subscriber, because a worker script that
// fails to load can report before App has mounted, and a notice lost to that
// ordering is the console-only failure this exists to replace.

type Listener = (message: string) => void

const reported: string[] = []
const listeners = new Set<Listener>()

// A plain `Event` (a script that failed to load) carries no message; an
// `ErrorEvent` (an exception inside the worker) does. The two cost the
// reviewer different things: a pool that cannot start falls back to the main
// thread, so code stays colored and only gets slower, while an exception in a
// running worker can leave the file it was highlighting plain.
export function describeWorkerError(event: ErrorEvent | Event): string {
  const detail = 'message' in event && typeof event.message === 'string' ? event.message : ''
  return detail
    ? `Syntax highlighting hit an error in its background worker: ${detail}. Some files may appear without colors.`
    : 'Syntax highlighting could not start its background worker and is running on the main thread, so a large review may load slowly.'
}

// Every worker in the pool reports the same script-load failure, so the same
// message is reported once rather than once per worker.
export function reportWorkerError(event: ErrorEvent | Event): void {
  const message = describeWorkerError(event)
  console.error(message, event)
  // Reported here; the browser's own uncaught-error line would be a duplicate.
  event.preventDefault()
  if (reported.includes(message)) return
  reported.push(message)
  for (const listener of listeners) listener(message)
}

export function subscribeWorkerErrors(listener: Listener): () => void {
  listeners.add(listener)
  for (const message of reported) listener(message)
  return () => {
    listeners.delete(listener)
  }
}

// For tests: the module-level state outlives a single test.
export function resetWorkerErrors(): void {
  reported.length = 0
  listeners.clear()
}
