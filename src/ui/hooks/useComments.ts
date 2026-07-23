import { useCallback, useMemo } from 'react'
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

async function fetchComments(): Promise<ReviewComment[]> {
  // includeDrafts=true: the browser is the only caller allowed to see
  // draft comments (rendered with a Draft badge). Every other caller of
  // this endpoint — notably `krit comments` — gets the agent-visible view.
  const res = await fetch('/api/comments?includeDrafts=true')
  return res.json()
}

export function useComments() {
  const queryClient = useQueryClient()
  const { data: comments = [] } = useQuery({ queryKey: COMMENTS_KEY, queryFn: fetchComments, refetchInterval: 3000 })

  const addMutation = useMutation({
    mutationFn: async (params: {
      filePath: string
      side: 'deletions' | 'additions'
      lineNumber: number
      endLine: number
      lineContent: string
      body: string
      suggestion?: { newLines: string[] }
      status?: 'draft'
      startColumn?: number
      endColumn?: number
      selectedText?: string
    }) => {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      return res.json() as Promise<ReviewComment>
    },
    onSuccess: (comment) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) => [...prev, comment])
    },
  })

  // Flips every draft to 'open' server-side in one batch (see
  // postDraftsAndBroadcast in server.ts) — used by the toolbar's "Post
  // drafts" button and implicitly by Submit ("Done reviewing").
  const postDraftsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/drafts/post', { method: 'POST' })
      return res.json() as Promise<{ ok: true; posted: number }>
    },
    onSuccess: () => {
      // Server-side status flip isn't reflected in our optimistic cache —
      // let the next 3s poll (or an immediate refetch) pick up the change.
      void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY })
    },
  })

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/comments/${id}`, { method: 'DELETE' })
      return id
    },
    onSuccess: (id) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) => prev.filter((c) => c.id !== id))
    },
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
      return res.json() as Promise<ReviewComment>
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      )
    },
  })

  const editMutation = useMutation({
    mutationFn: async ({ id, body, status }: { id: string; body?: string; status?: ReviewComment['status'] }) => {
      const res = await fetch(`/api/comments/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, status }),
      })
      return res.json() as Promise<ReviewComment>
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      )
    },
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
      asDraft?: boolean,
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
        ...(asDraft ? { status: 'draft' } : {}),
        ...(charAnchor
          ? { startColumn: charAnchor.startColumn, endColumn: charAnchor.endColumn, selectedText: charAnchor.selectedText }
          : {}),
      })
    },
    [addMutation],
  )

  const postDrafts = useCallback(() => {
    postDraftsMutation.mutate()
  }, [postDraftsMutation])

  const removeComment = useCallback(
    (id: string) => {
      removeMutation.mutate(id)
    },
    [removeMutation],
  )

  const editComment = useCallback(
    (id: string, body: string) => {
      editMutation.mutate({ id, body })
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
    // Drafts are "not yet visible to the agent" everywhere, including this
    // explicit copy action — matches the watcher/ws suppression, so a
    // reviewer can't accidentally leak an in-progress draft.
    const postable = comments.filter((c) => c.status !== 'draft')
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

  const draftCount = useMemo(() => comments.filter((c) => c.status === 'draft').length, [comments])

  return {
    comments,
    addComment,
    removeComment,
    editComment,
    resolveComment,
    replyToComment,
    postDrafts,
    draftCount,
    getAnnotationsForFile,
    formatAllComments,
    copyAllComments,
  }
}
