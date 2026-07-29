import { useState, useEffect, useCallback, useRef } from 'react'
import type { DiffScope } from './useDiff'

export type RefreshMode = 'manual' | 'live-unless-active' | 'ultra'

export interface Settings {
  staged: boolean
  untracked: boolean
  diffStyle: 'split' | 'unified'
  defaultTabSize: number
  browser?: string
  refreshMode: RefreshMode
  scope: DiffScope
}

const DEFAULTS: Settings = {
  staged: true,
  untracked: true,
  diffStyle: 'split',
  defaultTabSize: 4,
  refreshMode: 'live-unless-active',
  scope: 'uncommitted',
}

/// Server-managed metadata that travels inside the settings object but is not a
/// setting: present when the file on disk could not be used, so what we are
/// running on is defaults the user never chose. Split out of `Settings` before
/// the merge below — it must never be treated as a value to hold, send back, or
/// persist.
const SERVER_OWNED_KEY = 'settingsError'

export function splitSettingsError(data: unknown): {
  settings: Settings
  error?: string
} {
  if (data === null || typeof data !== 'object') return { settings: DEFAULTS }
  const { [SERVER_OWNED_KEY]: error, ...settings } = data as Record<string, unknown>
  return {
    settings: settings as unknown as Settings,
    error: typeof error === 'string' ? error : undefined,
  }
}

/// The load GET is a snapshot of the server from before the page finished
/// starting up. Anything the user has already changed by the time it lands is
/// newer than that snapshot, so it wins — otherwise a Split/Unified click made
/// during startup is silently reverted, and, worse, the reverted value is what
/// the next settings write sends back to the server, undoing the choice on
/// disk too.
export function mergeLoadedSettings(
  loaded: Settings,
  current: Settings,
  dirty: ReadonlySet<string>,
): Settings {
  const merged: Record<string, unknown> = { ...loaded }
  const held = current as unknown as Record<string, unknown>
  for (const key of dirty) {
    if (key in held) merged[key] = held[key]
  }
  return merged as unknown as Settings
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const [settingsError, setSettingsError] = useState<string | undefined>()
  const dirtyRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((data: unknown) => {
        const { settings: incoming, error } = splitSettingsError(data)
        setSettings((prev) => mergeLoadedSettings(incoming, prev, dirtyRef.current))
        setSettingsError(error)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    for (const key of Object.keys(patch)) dirtyRef.current.add(key)
    setSettings((prev) => ({ ...prev, ...patch }))
    // Send the patch, not the whole object. The server merges partials, and
    // our copy is only ever a snapshot: it omits keys this build doesn't know
    // about, and it is pure defaults if the load GET failed. Writing it back
    // wholesale would reset every setting we can't see to whatever we guessed.
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
      // The PUT response carries the same metadata as the GET, which is how a
      // refused write reaches the reviewer: the server won't overwrite a file it
      // couldn't read, so the toggle they just clicked did not persist and the
      // optimistic state above is now a lie until they fix the file.
      .then((res) => res.json())
      .then((data: unknown) => setSettingsError(splitSettingsError(data).error))
      .catch(() => {})
  }, [])

  return { settings, loaded, settingsError, updateSettings }
}
