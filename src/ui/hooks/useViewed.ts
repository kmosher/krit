import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

const VIEWED_KEY = ['viewed']

async function fetchViewed(): Promise<string[]> {
  const res = await fetch('/api/viewed')
  return res.json()
}

export function useViewed() {
  const queryClient = useQueryClient()
  const { data: viewedList = [] } = useQuery({ queryKey: VIEWED_KEY, queryFn: fetchViewed })

  // Memoized so a stable viewedList (react-query's structural sharing keeps
  // it referentially equal across unrelated refetches) yields a stable Set —
  // otherwise a brand-new Set every render would break DiffViewer's `memo`
  // on every scroll-driven re-render of App.
  const viewedFiles = useMemo(() => new Set(viewedList), [viewedList])

  const setViewed = useCallback(async (filePath: string, viewed: boolean) => {
    // Optimistic update
    queryClient.setQueryData<string[]>(VIEWED_KEY, (prev = []) => {
      if (viewed) {
        return prev.includes(filePath) ? prev : [...prev, filePath]
      }
      return prev.filter((f) => f !== filePath)
    })

    await fetch('/api/viewed', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, viewed }),
    })
  }, [queryClient])

  return { viewedFiles, setViewed }
}
