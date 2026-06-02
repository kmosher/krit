import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import { App } from './App'
import { workerFactory } from './workerFactory'
import './styles/global.css'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <WorkerPoolContextProvider
    poolOptions={{ workerFactory }}
    highlighterOptions={{}}
  >
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </WorkerPoolContextProvider>,
)
