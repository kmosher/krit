import { useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { DiffLineAnnotation } from '@pierre/diffs'
import type { ReviewComment } from '../../types'

const COMMENTS_KEY = ['comments']

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const lineAttr = (c: ReviewComment): string => {
  const endLine = c.endLine ?? c.lineNumber
  return endLine > c.lineNumber
    ? ` line="${c.lineNumber}" endLine="${endLine}"`
    : ` line="${c.lineNumber}"`
}

// Render the diff context for a comment as one or more `<code>` lines, prefixed with
// + (addition) or - (deletion) and XML-escaped so embedded `<` (generics, JSX, etc.) doesn't
// break the wrapper. Multi-line ranges keep one diff line per row.
const renderCodeBlock = (c: ReviewComment): string[] => {
  const prefix = c.side === 'additions' ? '+' : '-'
  const codeLines = c.lineContent.split('\n')
  if (codeLines.length === 1) return [`<code>${prefix} ${xmlEscape(codeLines[0])}</code>`]
  return [
    '<code>',
    ...codeLines.map((cl) => `${prefix} ${xmlEscape(cl)}`),
    '</code>',
  ]
}

async function fetchComments(): Promise<ReviewComment[]> {
  const res = await fetch('/api/comments')
  return res.json()
}

export function useComments() {
  const queryClient = useQueryClient()
  const { data: comments = [] } = useQuery({ queryKey: COMMENTS_KEY, queryFn: fetchComments, refetchInterval: 3000 })

  const addMutation = useMutation({
    mutationFn: async (params: { filePath: string; side: 'deletions' | 'additions'; lineNumber: number; endLine: number; lineContent: string; body: string }) => {
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
    (filePath: string, side: 'deletions' | 'additions', lineNumber: number, endLine: number, lineContent: string, body: string) => {
      addMutation.mutate({ filePath, side, lineNumber, endLine, lineContent, body })
    },
    [addMutation],
  )

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
    if (comments.length === 0) return ''

    const grouped = new Map<string, ReviewComment[]>()
    for (const comment of comments) {
      const list = grouped.get(comment.filePath) ?? []
      list.push(comment)
      grouped.set(comment.filePath, list)
    }

    const lines: string[] = ['<code-review-comments version="2">']
    for (const [filePath, fileComments] of grouped) {
      lines.push(`<file path="${xmlEscape(filePath)}">`)
      for (const comment of fileComments) {
        lines.push(`<comment${lineAttr(comment)}>`)
        lines.push(...renderCodeBlock(comment))
        lines.push(xmlEscape(comment.body))
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
          lineNumber: c.lineNumber,
          metadata: c,
        }))
    },
    [comments],
  )

  const copyAllComments = useCallback(async () => {
    const text = formatAllComments()
    await navigator.clipboard.writeText(text)
  }, [formatAllComments])

  return {
    comments,
    addComment,
    removeComment,
    editComment,
    resolveComment,
    replyToComment,
    getAnnotationsForFile,
    formatAllComments,
    copyAllComments,
  }
}
