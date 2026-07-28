import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useViewed } from './useViewed'

interface Put {
  filePath: string
  viewed: boolean
}

let puts: Put[]
let resolveGet: (paths: string[]) => void
let resolvePut: (() => void) | null
let queryClient: QueryClient

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client: queryClient }, children)
}

beforeEach(() => {
  puts = []
  resolvePut = null
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(init.body ?? '{}') as Put)
        // Held open so tests can observe the window between the optimistic
        // update and the server's acknowledgement.
        return new Promise<unknown>((resolve) => {
          resolvePut = () => resolve({ json: () => Promise.resolve({ ok: true }) })
        })
      }
      return new Promise<unknown>((resolve) => {
        resolveGet = (paths) => resolve({ json: () => Promise.resolve(paths) })
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useViewed', () => {
  it('starts empty so no file is collapsed before the list loads', async () => {
    // A file rendered as viewed collapses it, and CodeViewWrapper ends any
    // inline edit session on collapse — guessing "viewed" while the GET is in
    // flight would destroy an in-progress edit.
    const { result } = renderHook(() => useViewed(), { wrapper })
    expect(result.current.viewedFiles.size).toBe(0)
    await act(async () => resolveGet([]))
  })

  it('exposes the loaded list as a lookup set', async () => {
    const { result } = renderHook(() => useViewed(), { wrapper })
    await act(async () => resolveGet(['a.rs', 'b.rs']))
    await waitFor(() => expect(result.current.viewedFiles.size).toBe(2))
    expect(result.current.viewedFiles.has('a.rs')).toBe(true)
    expect(result.current.viewedFiles.has('c.rs')).toBe(false)
  })

  it('keeps the same Set instance across unrelated re-renders', async () => {
    // DiffViewer is memoized on this Set. A fresh Set per render re-renders
    // the whole diff on every scroll tick, and CodeViewWrapper's viewed-diff
    // pass would see spurious churn.
    const { result, rerender } = renderHook(() => useViewed(), { wrapper })
    await act(async () => resolveGet(['a.rs']))
    await waitFor(() => expect(result.current.viewedFiles.size).toBe(1))
    const first = result.current.viewedFiles
    rerender()
    rerender()
    expect(result.current.viewedFiles).toBe(first)
  })

  it('shows the checkbox as ticked before the server answers', async () => {
    // The toggle is a click on a checkbox: waiting for the round trip makes it
    // feel dead, and a fast second click would read the stale value.
    const { result } = renderHook(() => useViewed(), { wrapper })
    await act(async () => resolveGet([]))
    act(() => {
      void result.current.setViewed('a.rs', true)
    })
    await waitFor(() => expect(result.current.viewedFiles.has('a.rs')).toBe(true))
    expect(puts).toEqual([{ filePath: 'a.rs', viewed: true }])
    expect(resolvePut).not.toBeNull()
  })

  it('unticks optimistically too', async () => {
    const { result } = renderHook(() => useViewed(), { wrapper })
    await act(async () => resolveGet(['a.rs', 'b.rs']))
    await waitFor(() => expect(result.current.viewedFiles.size).toBe(2))
    act(() => {
      void result.current.setViewed('a.rs', false)
    })
    await waitFor(() => expect(result.current.viewedFiles.has('a.rs')).toBe(false))
    expect(result.current.viewedFiles.has('b.rs')).toBe(true)
    expect(puts).toEqual([{ filePath: 'a.rs', viewed: false }])
  })

  it('does not list a file twice when marked viewed again', async () => {
    // The list is what FileTree counts against; a duplicate would inflate the
    // "n of m viewed" progress and never clear on a single untick.
    const { result } = renderHook(() => useViewed(), { wrapper })
    await act(async () => resolveGet(['a.rs']))
    await waitFor(() => expect(result.current.viewedFiles.size).toBe(1))
    act(() => {
      void result.current.setViewed('a.rs', true)
    })
    expect(queryClient.getQueryData<string[]>(['viewed'])).toEqual(['a.rs'])
  })

  it('unticking a file that was never viewed is a no-op on the list', async () => {
    const { result } = renderHook(() => useViewed(), { wrapper })
    await act(async () => resolveGet(['a.rs']))
    await waitFor(() => expect(result.current.viewedFiles.size).toBe(1))
    act(() => {
      void result.current.setViewed('zzz.rs', false)
    })
    expect(queryClient.getQueryData<string[]>(['viewed'])).toEqual(['a.rs'])
  })

  it('applies both toggles when two files are ticked before either write lands', async () => {
    // Ticking through a file list quickly is the normal way to use this; an
    // update built from a captured snapshot would drop the first file.
    const { result } = renderHook(() => useViewed(), { wrapper })
    await act(async () => resolveGet([]))
    act(() => {
      void result.current.setViewed('a.rs', true)
      void result.current.setViewed('b.rs', true)
    })
    await waitFor(() => expect([...result.current.viewedFiles].sort()).toEqual(['a.rs', 'b.rs']))
    expect(puts).toEqual([
      { filePath: 'a.rs', viewed: true },
      { filePath: 'b.rs', viewed: true },
    ])
  })

  it('keeps the optimistic tick when the write fails', async () => {
    // There is no rollback and no error surface here by design: reverting the
    // checkbox under the reviewer's cursor is worse than a stale tick, which
    // the next load corrects.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { method?: string }) =>
        init?.method === 'PUT'
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({ json: () => Promise.resolve([]) }),
      ),
    )
    const { result } = renderHook(() => useViewed(), { wrapper })
    await waitFor(() => expect(result.current.viewedFiles.size).toBe(0))
    await act(async () => {
      await result.current.setViewed('a.rs', true).catch(() => {})
    })
    expect(result.current.viewedFiles.has('a.rs')).toBe(true)
  })

  it('a server refresh replaces the optimistic list', async () => {
    // Another tab (or the CLI) can mark files viewed; the fetched list is the
    // source of truth once it lands.
    const { result } = renderHook(() => useViewed(), { wrapper })
    await act(async () => resolveGet(['a.rs']))
    await waitFor(() => expect(result.current.viewedFiles.size).toBe(1))
    act(() => {
      queryClient.setQueryData<string[]>(['viewed'], ['b.rs', 'c.rs'])
    })
    await waitFor(() => expect([...result.current.viewedFiles].sort()).toEqual(['b.rs', 'c.rs']))
  })
})
