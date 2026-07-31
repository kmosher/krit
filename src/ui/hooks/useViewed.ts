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
    // Cancel any list load already in flight before touching the cache. A GET
    // that started before this tick answers with a list that predates it, and
    // react-query installs that answer over the optimistic write — the
    // checkbox clears itself a moment after the reviewer set it, with no error
    // and a PUT that succeeded. The window is every page still loading its
    // first list, which is exactly when a reviewer is marking files off.
    await queryClient.cancelQueries({ queryKey: VIEWED_KEY })

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
