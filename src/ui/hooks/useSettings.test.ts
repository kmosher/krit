import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import {
  mergeLoadedSettings,
  splitSettingsError,
  useSettings,
  type Settings,
} from './useSettings'

const SERVER: Settings & { launcher?: string } = {
  staged: true,
  untracked: true,
  diffStyle: 'unified',
  defaultTabSize: 4,
  refreshMode: 'live-unless-active',
  scope: 'uncommitted',
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

describe('splitSettingsError', () => {
  it('lifts the server metadata out of the settings object', () => {
    const { settings, error } = splitSettingsError({
      ...SERVER,
      settingsError: '~/.config/krit/settings.json is not valid JSON: trailing comma',
    })
    expect(error).toContain('not valid JSON')
    // Left in, it would be held as a setting and sent back on the next write.
    expect('settingsError' in settings).toBe(false)
    expect(settings.diffStyle).toBe('unified')
  })

  it('reports no error for the ordinary response', () => {
    expect(splitSettingsError(SERVER).error).toBeUndefined()
  })

  it('ignores a non-string in the metadata slot rather than rendering it', () => {
    expect(splitSettingsError({ ...SERVER, settingsError: { oops: true } }).error).toBeUndefined()
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

  it('surfaces a refused write, because the optimistic state is then a lie', async () => {
    // The server will not overwrite a settings file it could not parse, so the
    // toggle the reviewer just clicked did not persist. Without reading the PUT
    // response the UI would show it as applied and revert on the next load.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { method?: string }) =>
        Promise.resolve({
          json: () =>
            Promise.resolve({
              ...SERVER,
              settingsError:
                init?.method === 'PUT'
                  ? '~/.config/krit/settings.json is not valid JSON: x — not overwriting it'
                  : undefined,
            }),
        }),
      ),
    )
    const { result } = renderHook(() => useSettings())
    await act(async () => {
      result.current.updateSettings({ diffStyle: 'split' })
    })
    await waitFor(() => expect(result.current.settingsError).toContain('not overwriting it'))
  })
})
