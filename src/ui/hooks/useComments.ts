import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { DiffLineAnnotation } from '@pierre/diffs'
import type { ReviewComment } from '../../types'

const COMMENTS_KEY = ['comments']

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const lineAttr = (c: ReviewComment): string => {
  const endLine = c.endLine ?? c.lineNumber
  let range = endLine > c.lineNumber ? ` line="${c.lineNumber}" endLine="${endLine}"` : ` line="${c.lineNumber}"`
  // Schema v3: exact character offsets, when this comment was anchored to a
  // native text selection rather than whole lines (see SelectionPill).
  if (c.startColumn !== undefined && c.endColumn !== undefined) {
    range += ` startColumn="${c.startColumn}" endColumn="${c.endColumn}"`
  }
  // Surfaced so the agent knows this position is a best-effort re-anchor
  // (see reanchor.ts) rather than treating it as exact.
  return c.outdated ? `${range} outdated="true"` : range
}

// Render the diff context for a comment as one or more `<code>` lines, prefixed with
// + (addition) or - (deletion) and XML-escaped so embedded `<` (generics, JSX, etc.) doesn't
// break the wrapper. Multi-line ranges keep one diff line per row. When the comment carries
// a character-level anchor (schema v3), an extra <selected> block gives the agent the exact
// substring rather than making it recompute one from lineContent + column offsets.
const renderCodeBlock = (c: ReviewComment): string[] => {
  const prefix = c.side === 'additions' ? '+' : '-'
  const codeLines = c.lineContent.split('\n')
  const block =
    codeLines.length === 1
      ? [`<code>${prefix} ${xmlEscape(codeLines[0])}</code>`]
      : ['<code>', ...codeLines.map((cl) => `${prefix} ${xmlEscape(cl)}`), '</code>']
  if (c.selectedText !== undefined) {
    block.push(`<selected>${xmlEscape(c.selectedText)}</selected>`)
  }
  return block
}

// `fetch` only rejects when the request never completed; a 404 or a 500 is a
// resolved promise, and `res.json()` on one yields whatever the error body
// happened to be. Every call below funnels through here so a refused write
// reaches react-query as a rejection — without it a mutation's onSuccess runs
// on failure and writes an optimistic comment into the cache that the server
// does not have, which then survives until the next poll silently deletes it.
async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    // The server answers errors as plain text (see server.rs), and it is short:
    // worth reading, because "comment not found" and "read-only review" are the
    // two the reviewer can act on. A body we can't read is not worth a second
    // failure, so it degrades to the status line alone.
    const detail = await res.text().catch(() => '')
    throw new Error(`${what} failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  return res.json() as Promise<T>
}

async function fetchComments(): Promise<ReviewComment[]> {
  // includeQueued=true: the browser is the only caller allowed to see queued
  // comments (rendered with a Queued badge). Every other caller of this
  // endpoint — notably `krit comments` — gets the agent-visible view.
  const res = await fetch('/api/comments?includeQueued=true')
  return readJson<ReviewComment[]>(res, 'Loading comments')
}

/**
 * `onError` is how a failed write reaches the reader. Optional so the hook
 * still mounts in a test or a harness that doesn't care, but App always passes
 * one: a comment that silently fails to save looks exactly like a comment that
 * saved, right up until the next poll erases it.
 */
export function useComments(onError?: (message: string) => void) {
  const queryClient = useQueryClient()
  // Held in a ref so the mutations below don't have to list a caller-supplied
  // function in their identity — an inline arrow from App would otherwise
  // rebuild every mutation on each render.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const report = useCallback((err: unknown) => {
    onErrorRef.current?.(err instanceof Error ? err.message : String(err))
  }, [])

  const {
    data: comments = [],
    isError: loadFailed,
    error: loadError,
  } = useQuery({
    queryKey: COMMENTS_KEY,
    queryFn: fetchComments,
    refetchInterval: 3000,
    // react-query stops an interval while `document.visibilityState` is
    // 'hidden' — sensible for a page a person is not looking at, wrong for
    // this one. krit exists to be driven programmatically, and an automated
    // browser reports itself hidden, so the default leaves an agent staring
    // at whatever the comment list held when it last had focus, forever and
    // without a symptom. The polling cost is one small GET every 3s against
    // a server on loopback.
    refetchIntervalInBackground: true,
  })

  // The poll retries every 3s, so reporting each failure would stack a strip
  // every three seconds for as long as the server is down. Keyed on the
  // transition into failure instead: one strip per outage, and a new one only
  // after a poll has succeeded in between.
  // Deliberately not keyed on `loadError`: react-query hands back a fresh Error
  // object per failed attempt, so listing it would fire the effect on every
  // retry — the exact stacking this avoids. The ref carries the message in.
  const loadErrorRef = useRef(loadError)
  loadErrorRef.current = loadError
  useEffect(() => {
    if (loadFailed) report(loadErrorRef.current)
  }, [loadFailed, report])

  const addMutation = useMutation({
    mutationFn: async (params: {
      filePath: string
      side: 'deletions' | 'additions'
      lineNumber: number
      endLine: number
      lineContent: string
      body: string
      suggestion?: { newLines: string[] }
      status?: 'queued'
      startColumn?: number
      endColumn?: number
      selectedText?: string
    }) => {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      return readJson<ReviewComment>(res, 'Saving the comment')
    },
    onSuccess: (comment) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) => [...prev, comment])
    },
    onError: report,
  })

  // Flips every queued comment to 'open' server-side in one batch (see
  // post_queued_and_broadcast in server.rs) — used by the toolbar's "Post
  // queued" button and implicitly by Submit ("Done reviewing").
  const postQueuedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/queued/post', { method: 'POST' })
      return readJson<{ ok: true; posted: number }>(res, 'Posting queued comments')
    },
    onError: report,
    onSuccess: () => {
      // Server-side status flip isn't reflected in our optimistic cache —
      // let the next 3s poll (or an immediate refetch) pick up the change.
      void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY })
    },
  })

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/comments/${id}`, { method: 'DELETE' })
      // No body worth reading, but the status still decides whether the
      // comment is really gone — dropping it from the cache on a refusal makes
      // a deletion that didn't happen look like one that did.
      if (!res.ok) throw new Error(`Deleting the comment failed (${res.status})`)
      return id
    },
    onSuccess: (id) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) => prev.filter((c) => c.id !== id))
    },
    onError: report,
  })

  const replyMutation = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) => {
      // ?source=ui is required: the server treats unspecified source as CLI/agent so
      // unknown clients can't accidentally tag themselves as human and auto-reopen.
      const res = await fetch(`/api/comments/${id}/replies?source=ui`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      return readJson<ReviewComment>(res, 'Posting the reply')
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      )
    },
    onError: report,
  })

  // Every in-flight body edit, so the paths that post queued comments can wait
  // for them rather than racing them.
  const inFlightEdits = useRef(new Set<Promise<unknown>>())
  const settleEdits = useCallback(async () => {
    await Promise.allSettled([...inFlightEdits.current])
  }, [])

  const editMutation = useMutation({
    mutationFn: async ({
      id,
      body,
      status,
      expectStatus,
    }: {
      id: string
      body?: string
      status?: ReviewComment['status']
      // Refuses the write server-side unless the comment is still in this
      // state — see api_comment_put. The editor sends 'queued' so a save that
      // lost the race against "Post queued" fails loudly instead of rewriting
      // a comment the agent has already read.
      expectStatus?: ReviewComment['status']
    }) => {
      const res = await fetch(`/api/comments/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, status, expectStatus }),
      })
      // Both the body edit and the resolve flip land here, so the message says
      // "Updating" rather than naming one of them.
      return readJson<ReviewComment>(res, 'Updating the comment')
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      )
    },
    onError: report,
  })

  const addComment = useCallback(
    (
      filePath: string,
      side: 'deletions' | 'additions',
      lineNumber: number,
      endLine: number,
      lineContent: string,
      body: string,
      suggestion?: { newLines: string[] },
      asQueued?: boolean,
      charAnchor?: { startColumn: number; endColumn: number; selectedText: string },
    ) => {
      addMutation.mutate({
        filePath,
        side,
        lineNumber,
        endLine,
        lineContent,
        body,
        suggestion,
        ...(asQueued ? { status: 'queued' } : {}),
        ...(charAnchor
          ? { startColumn: charAnchor.startColumn, endColumn: charAnchor.endColumn, selectedText: charAnchor.selectedText }
          : {}),
      })
    },
    [addMutation],
  )

  // Posting waits for any save still in flight. Otherwise a rewrite saved a
  // moment before the click lands after the status flip, where the server now
  // refuses it (expectStatus) — correct, but it would throw away an edit the
  // reviewer had every reason to think was saved.
  const postQueued = useCallback(async () => {
    await settleEdits()
    postQueuedMutation.mutate()
  }, [postQueuedMutation, settleEdits])

  const removeComment = useCallback(
    (id: string) => {
      removeMutation.mutate(id)
    },
    [removeMutation],
  )

  // Awaitable, unlike the other mutations: its caller is a form holding text
  // the reviewer typed, and it has to know whether to keep that text on screen.
  const editComment = useCallback(
    async (id: string, body: string) => {
      const save = editMutation.mutateAsync({ id, body, expectStatus: 'queued' })
      inFlightEdits.current.add(save)
      try {
        await save
      } finally {
        inFlightEdits.current.delete(save)
      }
    },
    [editMutation],
  )

  const resolveComment = useCallback(
    (id: string) => {
      editMutation.mutate({ id, status: 'resolved' })
    },
    [editMutation],
  )

  const replyToComment = useCallback(
    (id: string, body: string) => {
      replyMutation.mutate({ id, body })
    },
    [replyMutation],
  )

  const formatAllComments = useCallback((): string => {
    // Queued comments are "not yet visible to the agent" everywhere, including
    // this explicit copy action — matches the watcher/ws suppression, so a
    // reviewer can't accidentally leak one they meant to hold back.
    const postable = comments.filter((c) => c.status !== 'queued')
    if (postable.length === 0) return ''

    const grouped = new Map<string, ReviewComment[]>()
    for (const comment of postable) {
      const list = grouped.get(comment.filePath) ?? []
      list.push(comment)
      grouped.set(comment.filePath, list)
    }

    // v3: adds startColumn/endColumn on <comment> and a <selected> block,
    // both only present when the comment has a character-level anchor.
    const lines: string[] = ['<code-review-comments version="3">']
    for (const [filePath, fileComments] of grouped) {
      lines.push(`<file path="${xmlEscape(filePath)}">`)
      for (const comment of fileComments) {
        lines.push(`<comment${lineAttr(comment)}>`)
        lines.push(...renderCodeBlock(comment))
        if (comment.body) lines.push(xmlEscape(comment.body))
        if (comment.suggestion) {
          // GitHub-style ```suggestion fence — the agent should treat
          // the fenced content as the literal replacement for the lines
          // [lineNumber, endLine] on this file.
          lines.push('<suggestion>')
          lines.push('```suggestion')
          for (const ln of comment.suggestion.newLines) lines.push(xmlEscape(ln))
          lines.push('```')
          lines.push('</suggestion>')
        }
        lines.push('</comment>')
      }
      lines.push('</file>')
    }
    lines.push('</code-review-comments>')

    return lines.join('\n')
  }, [comments])

  const getAnnotationsForFile = useCallback(
    (filePath: string): DiffLineAnnotation<ReviewComment>[] => {
      return comments
        .filter((c) => c.filePath === filePath)
        .map((c) => ({
          side: c.side,
          // Anchor at the bottom line of the range so the box renders below
          // the full selection, matching where the in-progress draft appears.
          lineNumber: c.endLine ?? c.lineNumber,
          metadata: c,
        }))
    },
    [comments],
  )

  const copyAllComments = useCallback(async () => {
    const text = formatAllComments()
    await navigator.clipboard.writeText(text)
  }, [formatAllComments])

  const queuedCount = useMemo(() => comments.filter((c) => c.status === 'queued').length, [comments])

  return {
    comments,
    addComment,
    removeComment,
    editComment,
    settleEdits,
    resolveComment,
    replyToComment,
    postQueued,
    queuedCount,
    getAnnotationsForFile,
    formatAllComments,
    copyAllComments,
  }
}
