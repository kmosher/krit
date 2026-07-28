import { useState, useEffect, useCallback, useRef } from 'react'

export type RefreshMode = 'manual' | 'live-unless-active' | 'ultra'

export interface Settings {
  staged: boolean
  untracked: boolean
  diffStyle: 'split' | 'unified'
  defaultTabSize: number
  browser?: string
  refreshMode: RefreshMode
}

const DEFAULTS: Settings = {
  staged: true,
  untracked: true,
  diffStyle: 'split',
  defaultTabSize: 4,
  refreshMode: 'live-unless-active',
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
  const dirtyRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((data: Settings) => {
        setSettings((prev) => mergeLoadedSettings(data, prev, dirtyRef.current))
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
  }, [])

  return { settings, loaded, updateSettings }
}
