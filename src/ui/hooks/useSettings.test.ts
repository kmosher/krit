import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { mergeLoadedSettings, useSettings, type Settings } from './useSettings'

const SERVER: Settings & { launcher?: string } = {
  staged: true,
  untracked: true,
  diffStyle: 'unified',
  defaultTabSize: 4,
  refreshMode: 'live-unless-active',
  launcher: 'app',
}

describe('mergeLoadedSettings', () => {
  const current: Settings = { ...SERVER, diffStyle: 'split' }

  it('keeps a setting the user changed while the load was in flight', () => {
    expect(mergeLoadedSettings(SERVER, current, new Set(['diffStyle'])).diffStyle).toBe('split')
  })

  it('takes the server value for everything the user did not touch', () => {
    expect(mergeLoadedSettings(SERVER, current, new Set()).diffStyle).toBe('unified')
  })

  it('carries through keys this build does not know about', () => {
    const merged = mergeLoadedSettings(SERVER, current, new Set(['diffStyle'])) as { launcher?: string }
    expect(merged.launcher).toBe('app')
  })
})

describe('useSettings', () => {
  let resolveGet: (value: unknown) => void
  let puts: Array<Record<string, unknown>>

  beforeEach(() => {
    puts = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === 'PUT') {
          puts.push(JSON.parse(init.body ?? '{}'))
          return Promise.resolve({ json: () => Promise.resolve(SERVER) })
        }
        return new Promise((resolve) => {
          resolveGet = () => resolve({ json: () => Promise.resolve(SERVER) })
        })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not let a late load revert a choice the user already made', async () => {
    // Flipping Split/Unified right after opening krit is the common case — the
    // toolbar is on screen well before the settings GET lands.
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSettings({ diffStyle: 'split' }))
    expect(result.current.settings.diffStyle).toBe('split')

    await act(async () => {
      resolveGet(null)
    })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.settings.diffStyle).toBe('split')
  })

  it('applies the loaded value for settings the user has not touched', async () => {
    const { result } = renderHook(() => useSettings())
    await act(async () => {
      resolveGet(null)
    })
    await waitFor(() => expect(result.current.settings.diffStyle).toBe('unified'))
  })

  it('writes only the keys that changed', async () => {
    // A whole-object write would send our snapshot back — pure defaults if the
    // load failed, and always missing keys this build does not model, so it
    // would quietly reset them on disk.
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSettings({ diffStyle: 'split' }))
    expect(puts).toEqual([{ diffStyle: 'split' }])
  })

  it('still writes when the settings load failed outright', async () => {
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSettings({ refreshMode: 'ultra' }))
    expect(puts).toEqual([{ refreshMode: 'ultra' }])
    expect(result.current.settings.refreshMode).toBe('ultra')
  })
})
