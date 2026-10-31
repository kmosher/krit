import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import { App } from './App'
import { workerFactory } from './workerFactory'
import { reportWorkerError } from './workerErrors'
import './styles/global.css'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  // `highlights` is Pierre's own WASM highlighter (beta). It is fast enough that
  // a worker round trip costs more than the work, so anything up to 100k
  // characters is highlighted on the main thread and arrives already colored
  // rather than as a plain-text pass first; larger files still go to workers.
  // That pairing is upstream's recommendation — `mainThreadMaxCharacters` with
  // the default Shiki backend would put slow work on the main thread. A
  // language it has no lexer for renders plain rather than failing.
  <WorkerPoolContextProvider
    poolOptions={{ workerFactory, onWorkerError: reportWorkerError, mainThreadMaxCharacters: 100_000 }}
    highlighterOptions={{ preferredHighlighter: 'highlights' }}
  >
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </WorkerPoolContextProvider>,
)
