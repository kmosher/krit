// Factory used by @pierre/diffs's WorkerPoolContextProvider to spawn the
// off-main-thread tokenizer workers. Vite's ?worker&url query gives us a
// browser-resolvable URL to the lib's prebuilt worker entry; the factory
// instantiates one per worker slot in the pool (default 8).
import WorkerUrl from '@pierre/diffs/worker/worker.js?worker&url'

export function workerFactory(): Worker {
  return new Worker(WorkerUrl, { type: 'module' })
}
