import { useCallback, useEffect, useRef, useState } from 'react'
import type { PendingDraft } from '../../types'

// The client-side shape of an in-progress draft, as CodeViewWrapper holds it in
// its `pending` map. Declared here rather than imported to keep this module
// free of the component: only these fields cross the wire.
export interface DraftLike {
  itemId: string
  side: 'deletions' | 'additions'
  startLine: number
  endLine: number
  body: string
  suggestMode: boolean
  suggestionText: string
  charAnchor?: { startColumn: number; endColumn: number; selectedText: string }
}

// `itemId` *is* the file path — CodeView keys its items by path — so the client
// and wire shapes differ only in that name and the flattened char anchor.
export function toWire(draft: DraftLike, updatedAt: number): PendingDraft {
  return {
    filePath: draft.itemId,
    side: draft.side,
    startLine: draft.startLine,
    endLine: draft.endLine,
    body: draft.body,
    suggestMode: draft.suggestMode,
    suggestionText: draft.suggestionText,
    ...(draft.charAnchor
      ? {
          startColumn: draft.charAnchor.startColumn,
          endColumn: draft.charAnchor.endColumn,
          selectedText: draft.charAnchor.selectedText,
        }
      : {}),
    updatedAt,
  }
}

export function fromWire(w: PendingDraft): DraftLike {
  // All three anchor fields or none — a partial anchor would place a
  // character-range comment using a column it doesn't have.
  const hasAnchor =
    w.startColumn !== undefined && w.endColumn !== undefined && w.selectedText !== undefined
  return {
    itemId: w.filePath,
    side: w.side,
    startLine: w.startLine,
    endLine: w.endLine,
    body: w.body,
    suggestMode: w.suggestMode,
    suggestionText: w.suggestionText,
    ...(hasAnchor
      ? {
          charAnchor: {
            startColumn: w.startColumn!,
            endColumn: w.endColumn!,
            selectedText: w.selectedText!,
          },
        }
      : {}),
  }
}

export function slotKey(d: Pick<DraftLike, 'itemId' | 'side' | 'startLine' | 'endLine'>): string {
  return `${d.itemId}:${d.side}:${d.startLine}-${d.endLine}`
}

// Long enough that a fast typist produces one write per phrase rather than per
// keystroke, short enough that the text is on disk before anyone reaches for the
// close button. The draft is only lost if the process dies inside this window.
const WRITE_DEBOUNCE_MS = 400

/**
 * Server-side persistence for comment text that has not been submitted.
 *
 * Reads once on mount and hands the result back for hydration; thereafter it is
 * write-only. There is deliberately no subscription: the server does not
 * broadcast draft changes (see the route comments in server.rs), because
 * echoing a reviewer's own keystrokes back into the form they came from is a
 * fight, not a feature.
 *
 * `persist` is debounced per slot, so a burst of typing in one form collapses to
 * one request while a second form's draft is unaffected.
 */
export function usePendingDrafts() {
  const [restored, setRestored] = useState<DraftLike[] | null>(null)
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const latest = useRef<Map<string, DraftLike>>(new Map())

  useEffect(() => {
    let live = true
    fetch('/api/pending-drafts')
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: PendingDraft[]) => {
        if (live) setRestored(Array.isArray(rows) ? rows.map(fromWire) : [])
      })
      // A failed read means no restore, not a broken review — the reviewer
      // simply starts from an empty form, which is where they were anyway.
      .catch(() => {
        if (live) setRestored([])
      })
    return () => {
      live = false
    }
  }, [])

  // `keepalive` is for the page-unload path: the document is going away, so an
  // ordinary fetch would be cancelled with it. It costs nothing on the normal
  // debounce path, but is only set where it's needed to keep the two callers
  // distinguishable.
  const flush = useCallback((key: string, keepalive = false) => {
    const draft = latest.current.get(key)
    if (!draft) return
    timers.current.delete(key)
    void fetch('/api/pending-drafts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toWire(draft, Date.now())),
      keepalive,
    }).catch(() => {})
  }, [])

  const persist = useCallback(
    (draft: DraftLike) => {
      const key = slotKey(draft)
      // Snapshot the fields now. CodeViewWrapper mutates the draft object in
      // place on every keystroke (deliberately — a state update there rebuilds
      // the file's annotation DOM), so holding the reference would send
      // whatever the text had become by the time the timer fired. That is
      // usually the same thing, but not after a submit clears the form.
      latest.current.set(key, { ...draft })
      const existing = timers.current.get(key)
      if (existing) clearTimeout(existing)
      timers.current.set(key, setTimeout(() => flush(key), WRITE_DEBOUNCE_MS))
    },
    [flush],
  )

  const forget = useCallback((draft: Pick<DraftLike, 'itemId' | 'side' | 'startLine' | 'endLine'>) => {
    const key = slotKey(draft)
    // Cancel any queued write first, or the debounce fires after the delete and
    // resurrects the draft the reviewer just submitted or discarded.
    const existing = timers.current.get(key)
    if (existing) clearTimeout(existing)
    timers.current.delete(key)
    latest.current.delete(key)
    void fetch('/api/pending-drafts/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: draft.itemId,
        side: draft.side,
        startLine: draft.startLine,
        endLine: draft.endLine,
      }),
    }).catch(() => {})
  }, [])

  const flushAll = useCallback(
    (keepalive: boolean) => {
      for (const key of [...timers.current.keys()]) {
        clearTimeout(timers.current.get(key)!)
        flush(key, keepalive)
      }
    },
    [flush],
  )

  // Two different ways the debounce window can end without the timer firing,
  // and only one of them is an unmount.
  //
  // A reload or a closed tab does NOT unmount anything: React cleanup runs when
  // a component leaves a live tree, not when the document is torn down. So the
  // effect cleanup below covers an in-app unmount, and `pagehide` covers the
  // navigation — which is the case this whole feature exists for, and the case
  // that looked covered until a real browser said otherwise. `pagehide` rather
  // than `visibilitychange`: an automated browser reports itself hidden for its
  // entire run (see the note on the comment poll), so hidden is not a signal
  // that anything is going away.
  useEffect(() => {
    const onPageHide = () => flushAll(true)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      flushAll(false)
    }
  }, [flushAll])

  return { restored, persist, forget }
}
