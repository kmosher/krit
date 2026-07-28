import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useComments } from './useComments'
import type { ReviewComment } from '../../types'
import { makeComment } from '../test-utils'

interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[]
let server: ReviewComment[]
let queryClient: QueryClient
/** Set by a test to make the next matching request reject. */
let failMethod: string | null
/**
 * Set by a test to make every matching request answer with an HTTP error.
 * Distinct from `failMethod`: that one is "the request never completed", this
 * one is "the server answered, and said no" — the case `fetch` reports as a
 * perfectly ordinary resolved promise.
 */
let refuse: { method: string; status: number; body?: string } | null
/** What App passes in; collects the messages the reader would have seen. */
let reported: string[]

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client: queryClient }, children)
}

// A stand-in for the Rust server: it records every request and answers with
// the shapes krit/src/server.rs actually returns — the created comment for
// POST, the whole updated comment for PUT and for a reply, `{ok, posted}` for
// the draft flush. Tests mutate `server` to stage what the next GET returns,
// which is how a reanchor (a server-side rewrite the client only learns about
// on its next poll) is spelled here.
beforeEach(() => {
  calls = []
  server = []
  failMethod = null
  refuse = null
  reported = []
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body) : undefined
      calls.push({ url, method, body })
      if (failMethod === method) return Promise.reject(new Error('network down'))
      if (refuse && refuse.method === method) {
        const { status, body: text } = refuse
        return Promise.resolve({
          ok: false,
          status,
          text: () => Promise.resolve(text ?? ''),
          // Present so a hook that ignored `ok` would sail past this and pass —
          // the mock must not be what catches the mistake.
          json: () => Promise.resolve({ error: text ?? 'refused' }),
        })
      }

      if (method === 'GET') return Promise.resolve({ ok: true, json: () => Promise.resolve(server) })

      if (method === 'POST' && url === '/api/comments') {
        const created = makeComment({ id: `srv-${server.length + 1}`, ...(body as Partial<ReviewComment>) })
        server = [...server, created]
        return Promise.resolve({ ok: true, json: () => Promise.resolve(created) })
      }
      if (method === 'POST' && url === '/api/drafts/post') {
        const posted = server.filter((c) => c.status === 'draft').length
        server = server.map((c) => (c.status === 'draft' ? { ...c, status: 'open' as const } : c))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, posted }) })
      }
      if (method === 'POST') {
        // .../replies — the server appends and returns the whole comment, with
        // `status` reflecting the reopen a human reply triggers.
        const id = url.split('/')[3]
        const updated = {
          ...server.find((c) => c.id === id)!,
          status: 'open' as const,
          replies: [{ id: 'r1', body: (body as { body: string }).body, createdAt: 2, author: 'user' as const }],
        }
        server = server.map((c) => (c.id === id ? updated : c))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(updated) })
      }
      if (method === 'PUT') {
        const id = url.split('/')[3]
        const patch = body as { body?: string; status?: ReviewComment['status'] }
        const updated = {
          ...server.find((c) => c.id === id)!,
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
        }
        server = server.map((c) => (c.id === id ? updated : c))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(updated) })
      }
      // DELETE returns no body the hook reads.
      const id = url.split('/')[3]
      server = server.filter((c) => c.id !== id)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Mount the hook with `seed` already on the server and loaded into the cache. */
async function mount(seed: ReviewComment[] = []) {
  server = seed
  const rendered = renderHook(() => useComments((m) => reported.push(m)), { wrapper })
  await waitFor(() => expect(rendered.result.current.comments).toHaveLength(seed.length))
  return rendered
}

/** What the 3s refetchInterval does, without waiting three seconds. */
async function poll(result: { current: ReturnType<typeof useComments> }, expected: number) {
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: ['comments'] })
  })
  await waitFor(() => expect(result.current.comments).toHaveLength(expected))
}

describe('loading', () => {
  it('asks for drafts, which no other client of this endpoint may see', async () => {
    // The browser is the only caller allowed the draft view. Drop the flag and
    // a reviewer's saved drafts vanish from their own screen mid-review.
    await mount([])
    expect(calls[0]).toMatchObject({ url: '/api/comments?includeDrafts=true', method: 'GET' })
  })

  it('keeps polling while the page is in the background', async () => {
    // react-query pauses an interval when the page is unfocused, which is the
    // right default for a page a person is reading and the wrong one here: an
    // automated browser reports itself hidden the whole time it is driving
    // krit, so without refetchIntervalInBackground an agent's comment list
    // freezes at whatever it held on load and never says so.
    //
    // focusManager is what react-query actually consults, so the test drives
    // that rather than document.visibilityState — happy-dom's visibility does
    // not reach the same decision.
    const { result } = await mount([])
    const before = calls.length
    focusManager.setFocused(false)
    try {
      server = [makeComment({ id: 'a' })]
      await waitFor(() => expect(result.current.comments).toHaveLength(1), { timeout: 5000 })
      expect(calls.length).toBeGreaterThan(before)
    } finally {
      focusManager.setFocused(undefined)
    }
  })
})

describe('adding a comment', () => {
  it('sends the anchor the reviewer selected and shows the comment immediately', async () => {
    const { result } = await mount()
    act(() => {
      result.current.addComment('src/a.rs', 'additions', 4, 6, 'a\nb\nc', 'look here')
    })
    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    expect(calls.at(-1)).toMatchObject({
      url: '/api/comments',
      method: 'POST',
      body: {
        filePath: 'src/a.rs',
        side: 'additions',
        lineNumber: 4,
        endLine: 6,
        lineContent: 'a\nb\nc',
        body: 'look here',
      },
    })
  })

  it('marks a comment draft only when the reviewer asked for a draft', async () => {
    // status is what suppresses the agent broadcast; sending 'draft' by
    // accident silently withholds a posted comment from the agent, and
    // omitting it leaks an in-progress one.
    const { result } = await mount()
    act(() => {
      result.current.addComment('src/a.rs', 'additions', 4, 4, 'x', 'later', undefined, true)
    })
    await waitFor(() => expect(result.current.draftCount).toBe(1))
    expect((calls.at(-1)!.body as { status?: string }).status).toBe('draft')

    act(() => {
      result.current.addComment('src/a.rs', 'additions', 5, 5, 'y', 'now')
    })
    await waitFor(() => expect(result.current.comments).toHaveLength(2))
    expect(calls.at(-1)!.body).not.toHaveProperty('status')
  })

  it('sends the character anchor only when the comment has one', async () => {
    // A line-only comment must not carry startColumn/endColumn: pre-v3
    // consumers key off their absence, and a bogus zero-width range would
    // narrow the agent's view to nothing.
    const { result } = await mount()
    act(() => {
      result.current.addComment('src/a.rs', 'additions', 4, 4, 'let x = 1;', 'this', undefined, false, {
        startColumn: 4,
        endColumn: 5,
        selectedText: 'x',
      })
    })
    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    expect(calls.at(-1)!.body).toMatchObject({ startColumn: 4, endColumn: 5, selectedText: 'x' })

    act(() => {
      result.current.addComment('src/a.rs', 'additions', 9, 9, 'z', 'plain')
    })
    await waitFor(() => expect(result.current.comments).toHaveLength(2))
    expect(calls.at(-1)!.body).not.toHaveProperty('startColumn')
    expect(calls.at(-1)!.body).not.toHaveProperty('selectedText')
  })

  it('forwards a suggestion payload', async () => {
    const { result } = await mount()
    act(() => {
      result.current.addComment('src/a.rs', 'additions', 4, 4, 'old', 'try this', { newLines: ['new'] })
    })
    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    expect(calls.at(-1)!.body).toMatchObject({ suggestion: { newLines: ['new'] } })
  })

  it('keeps the comments already on screen when a new one is added', async () => {
    // The optimistic append replaces the whole list; overwriting instead of
    // appending would blank a reviewer's earlier comments until the next poll.
    const { result } = await mount([makeComment({ id: 'a' }), makeComment({ id: 'b' })])
    act(() => {
      result.current.addComment('src/a.rs', 'additions', 4, 4, 'x', 'third')
    })
    await waitFor(() => expect(result.current.comments).toHaveLength(3))
    expect(result.current.comments.map((c) => c.id)).toEqual(['a', 'b', 'srv-3'])
  })

  it('shows both comments when two are added before either response lands', async () => {
    const { result } = await mount()
    act(() => {
      result.current.addComment('src/a.rs', 'additions', 1, 1, 'x', 'one')
      result.current.addComment('src/b.rs', 'additions', 2, 2, 'y', 'two')
    })
    await waitFor(() => expect(result.current.comments).toHaveLength(2))
    expect(result.current.comments.map((c) => c.body)).toEqual(['one', 'two'])
  })

  it('leaves the existing comments alone when the POST fails', async () => {
    // No rollback is needed because nothing is added until the server answers,
    // but a failure must not take the rest of the review down with it.
    const { result } = await mount([makeComment({ id: 'a' })])
    failMethod = 'POST'
    await act(async () => {
      result.current.addComment('src/a.rs', 'additions', 4, 4, 'x', 'lost')
      await Promise.resolve()
    })
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(result.current.comments.map((c) => c.id)).toEqual(['a'])
  })
})

describe('editing, resolving and deleting', () => {
  it('edits the body in place without touching the other comments', async () => {
    const { result } = await mount([makeComment({ id: 'a' }), makeComment({ id: 'b', body: 'other' })])
    act(() => result.current.editComment('a', 'rewritten'))
    await waitFor(() => expect(result.current.comments[0].body).toBe('rewritten'))
    expect(result.current.comments.map((c) => c.id)).toEqual(['a', 'b'])
    expect(result.current.comments[1].body).toBe('other')
    expect(calls.at(-1)).toMatchObject({ url: '/api/comments/a', method: 'PUT', body: { body: 'rewritten' } })
  })

  it('resolving sends only a status, so it cannot blank the body', async () => {
    // The PUT body is spread onto the stored comment; sending body:'' here
    // would erase the reviewer's text on every Resolve click.
    const { result } = await mount([makeComment({ id: 'a', body: 'keep me' })])
    act(() => result.current.resolveComment('a'))
    await waitFor(() => expect(result.current.comments[0].status).toBe('resolved'))
    expect(calls.at(-1)!.body).toEqual({ status: 'resolved' })
    expect(result.current.comments[0].body).toBe('keep me')
  })

  it('removes only the deleted comment', async () => {
    const { result } = await mount([makeComment({ id: 'a' }), makeComment({ id: 'b' })])
    act(() => result.current.removeComment('a'))
    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    expect(result.current.comments[0].id).toBe('b')
    expect(calls.at(-1)).toMatchObject({ url: '/api/comments/a', method: 'DELETE' })
  })

  it('keeps the comment on screen when the delete fails', async () => {
    // Removing it optimistically and losing the write would hide a comment the
    // agent still sees — the reviewer would think it was retracted.
    const { result } = await mount([makeComment({ id: 'a' })])
    failMethod = 'DELETE'
    await act(async () => {
      result.current.removeComment('a')
      await Promise.resolve()
    })
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true))
    expect(result.current.comments).toHaveLength(1)
  })

  it('applies two edits to different comments concurrently', async () => {
    // Each onSuccess maps over the previous list rather than a snapshot taken
    // when the request was fired; a snapshot would let the second response
    // discard the first edit.
    const { result } = await mount([makeComment({ id: 'a' }), makeComment({ id: 'b' })])
    act(() => {
      result.current.editComment('a', 'A!')
      result.current.editComment('b', 'B!')
    })
    await waitFor(() => expect(result.current.comments.map((c) => c.body)).toEqual(['A!', 'B!']))
  })

  it('ignores an update for a comment that is already gone', async () => {
    // Deleting a comment whose edit is still in flight is easy to do; a map
    // that reinserted the missing id would resurrect it.
    const { result } = await mount([makeComment({ id: 'a' }), makeComment({ id: 'b' })])
    act(() => {
      result.current.editComment('a', 'edited')
      result.current.removeComment('a')
    })
    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    expect(result.current.comments[0].id).toBe('b')
  })
})

describe('replying', () => {
  it('tags the reply as coming from the browser', async () => {
    // Without ?source=ui the server files the reply as the agent's own, so it
    // neither reopens the comment nor reaches the agent as human input.
    const { result } = await mount([makeComment({ id: 'a', status: 'resolved' })])
    act(() => result.current.replyToComment('a', 'still wrong'))
    await waitFor(() => expect(result.current.comments[0].replies).toHaveLength(1))
    expect(calls.at(-1)).toMatchObject({ url: '/api/comments/a/replies?source=ui', method: 'POST' })
    expect(calls.at(-1)!.body).toEqual({ body: 'still wrong' })
  })

  it('adopts the status the server returned with the reply', async () => {
    // A human reply reopens a resolved comment server-side. Keeping the local
    // 'resolved' would leave the thread hidden behind the resolved filter
    // while the agent is being asked to act on it.
    const { result } = await mount([makeComment({ id: 'a', status: 'resolved' })])
    act(() => result.current.replyToComment('a', 'reopen please'))
    await waitFor(() => expect(result.current.comments[0].status).toBe('open'))
  })

  it('leaves other comments untouched', async () => {
    const { result } = await mount([makeComment({ id: 'a' }), makeComment({ id: 'b' })])
    act(() => result.current.replyToComment('b', 'hi'))
    await waitFor(() => expect(result.current.comments[1].replies).toHaveLength(1))
    expect(result.current.comments[0].replies).toHaveLength(0)
    expect(result.current.comments.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('posting drafts', () => {
  it('flushes drafts in one request and refetches the flipped statuses', async () => {
    // The status flip happens server-side and is not mirrored optimistically,
    // so without the invalidate the Draft badges linger for up to 3s after
    // "Done reviewing" — including on comments the agent already has.
    const { result } = await mount([makeComment({ id: 'a', status: 'draft' }), makeComment({ id: 'b', status: 'draft' })])
    expect(result.current.draftCount).toBe(2)
    act(() => result.current.postDrafts())
    await waitFor(() => expect(result.current.draftCount).toBe(0))
    expect(calls.filter((c) => c.url === '/api/drafts/post')).toHaveLength(1)
    expect(result.current.comments.every((c) => c.status === 'open')).toBe(true)
  })

  it('counts only drafts', async () => {
    const { result } = await mount([
      makeComment({ id: 'a', status: 'draft' }),
      makeComment({ id: 'b', status: 'open' }),
      makeComment({ id: 'c', status: 'resolved' }),
    ])
    expect(result.current.draftCount).toBe(1)
  })
})

describe('reacting to a server-side reanchor', () => {
  // The Rust side (krit/src/reanchor.rs) rewrites a comment's lineNumber when
  // the file it points at is edited, and flags it `outdated` when it cannot
  // find the anchor. The client has no event for this: it learns on its next
  // poll, and everything downstream reads the refetched comment.

  it("moves the annotation to the comment's new line", async () => {
    // The annotation position is what places the bubble in the diff. If the
    // client kept the pre-edit line, every comment on a file the agent touched
    // would render against unrelated code.
    const { result } = await mount([makeComment({ id: 'a', filePath: 'src/a.rs', lineNumber: 10, endLine: 10 })])
    expect(result.current.getAnnotationsForFile('src/a.rs')[0].lineNumber).toBe(10)

    server = [makeComment({ id: 'a', filePath: 'src/a.rs', lineNumber: 42, endLine: 42 })]
    await poll(result, 1)
    expect(result.current.getAnnotationsForFile('src/a.rs')[0]).toMatchObject({
      lineNumber: 42,
      side: 'additions',
    })
    expect(result.current.getAnnotationsForFile('src/a.rs')[0].metadata.lineNumber).toBe(42)
  })

  it('follows the end of a multi-line range that moved', async () => {
    // The bubble hangs off the last line of the range so it sits below the
    // whole selection; anchoring at the start would put it inside the range.
    const { result } = await mount([makeComment({ id: 'a', filePath: 'src/a.rs', lineNumber: 10, endLine: 12 })])
    server = [makeComment({ id: 'a', filePath: 'src/a.rs', lineNumber: 20, endLine: 22 })]
    await poll(result, 1)
    expect(result.current.getAnnotationsForFile('src/a.rs')[0].lineNumber).toBe(22)
  })

  it('tells the agent when a position is only a best-effort re-anchor', async () => {
    // outdated="true" is the agent's cue that the lines are last-known rather
    // than exact. Dropping it makes the agent edit at a stale position with
    // full confidence.
    const { result } = await mount([makeComment({ id: 'a', filePath: 'src/a.rs', lineNumber: 10, endLine: 10 })])
    expect(result.current.formatAllComments()).not.toContain('outdated')

    server = [makeComment({ id: 'a', lineNumber: 10, endLine: 10, outdated: true })]
    await poll(result, 1)
    expect(result.current.formatAllComments()).toContain('<comment line="10" outdated="true">')
  })

  it('clears the outdated flag when the server re-finds the anchor', async () => {
    // reanchor.rs sets outdated back to false once the text reappears (an undo,
    // typically). A client that only ever added the flag would keep warning.
    const { result } = await mount([makeComment({ id: 'a', outdated: true })])
    expect(result.current.formatAllComments()).toContain('outdated="true"')
    server = [makeComment({ id: 'a', outdated: false, lineNumber: 11, endLine: 11 })]
    await poll(result, 1)
    expect(result.current.formatAllComments()).not.toContain('outdated')
  })

  it('keeps an outdated comment visible and commentable', async () => {
    // outdated is independent of status: the comment is still open and still
    // useful context. Filtering it out would silently drop review feedback.
    const { result } = await mount([makeComment({ id: 'a', filePath: 'src/a.rs', body: 'why 1?', outdated: true, status: 'open' })])
    expect(result.current.comments).toHaveLength(1)
    expect(result.current.getAnnotationsForFile('src/a.rs')).toHaveLength(1)
    expect(result.current.formatAllComments()).toContain('why 1?')
  })

  it('a poll does not resurrect a comment the reviewer deleted meanwhile', async () => {
    // The delete goes to the server first, so the refetched list is already
    // without it — this pins that the client takes the server list wholesale
    // rather than merging it into the optimistic one.
    const { result } = await mount([makeComment({ id: 'a' }), makeComment({ id: 'b' })])
    act(() => result.current.removeComment('a'))
    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    await poll(result, 1)
    expect(result.current.comments.map((c) => c.id)).toEqual(['b'])
  })

  it('a reanchor poll does not clobber a reply that just landed', async () => {
    const { result } = await mount([makeComment({ id: 'a' })])
    act(() => result.current.replyToComment('a', 'hello'))
    await waitFor(() => expect(result.current.comments[0].replies).toHaveLength(1))
    server = server.map((c) => ({ ...c, lineNumber: 30, endLine: 30 }))
    await poll(result, 1)
    expect(result.current.comments[0].replies).toHaveLength(1)
    expect(result.current.comments[0].lineNumber).toBe(30)
  })
})

describe('annotations', () => {
  it("returns only the requested file's comments", async () => {
    // Every file asks for its own annotations; leaking another file's would
    // render its bubbles at whatever line number happened to exist here.
    const { result } = await mount([
      makeComment({ id: 'a', filePath: 'src/a.rs' }),
      makeComment({ id: 'b', filePath: 'src/b.rs' }),
    ])
    const forA = result.current.getAnnotationsForFile('src/a.rs')
    expect(forA).toHaveLength(1)
    expect(forA[0].metadata.id).toBe('a')
    expect(result.current.getAnnotationsForFile('src/c.rs')).toEqual([])
  })

  it('falls back to lineNumber when endLine is absent', async () => {
    // endLine is optional in the schema for external comment stores; an
    // undefined annotation line drops the bubble out of the diff entirely.
    const { result } = await mount([makeComment({ id: 'a', filePath: 'src/a.rs', lineNumber: 7, endLine: undefined })])
    expect(result.current.getAnnotationsForFile('src/a.rs')[0].lineNumber).toBe(7)
  })

  it('keeps the deletion side', async () => {
    // Side picks the column in split view; the wrong one puts the comment on
    // code the reviewer was not looking at.
    const { result } = await mount([makeComment({ id: 'a', filePath: 'src/a.rs', side: 'deletions' })])
    expect(result.current.getAnnotationsForFile('src/a.rs')[0].side).toBe('deletions')
  })
})

describe('formatAllComments', () => {
  it('withholds drafts from the copied text', async () => {
    // Copy is the manual path to the agent, and a draft is by definition not
    // yet meant for it — leaking one here defeats the whole draft mechanism.
    const { result } = await mount([
      makeComment({ id: 'a', status: 'draft', body: 'secret' }),
      makeComment({ id: 'b', body: 'public' }),
    ])
    const out = result.current.formatAllComments()
    expect(out).toContain('public')
    expect(out).not.toContain('secret')
  })

  it('produces nothing at all when everything is a draft', async () => {
    // An empty string is what lets the caller skip the copy; an empty wrapper
    // element would hand the agent a review with no content in it.
    const { result } = await mount([makeComment({ id: 'a', status: 'draft' })])
    expect(result.current.formatAllComments()).toBe('')
  })

  it('groups comments under one element per file', async () => {
    const { result } = await mount([
      makeComment({ id: 'a', filePath: 'src/a.rs', body: 'one' }),
      makeComment({ id: 'b', filePath: 'src/b.rs', body: 'two' }),
      makeComment({ id: 'c', filePath: 'src/a.rs', body: 'three' }),
    ])
    const out = result.current.formatAllComments()
    expect(out.match(/<file path="src\/a.rs">/g)).toHaveLength(1)
    expect(out.indexOf('three')).toBeLessThan(out.indexOf('<file path="src/b.rs">'))
  })

  it('escapes markup in code, body and path so the wrapper stays parseable', async () => {
    // Generics and JSX are exactly what gets reviewed. An unescaped `<` turns
    // the payload into malformed XML and the agent misreads the whole review.
    const { result } = await mount([
      makeComment({
        id: 'a',
        filePath: 'src/<x>.rs',
        lineContent: 'Vec<T> & U',
        body: 'a < b && c > d',
      }),
    ])
    const out = result.current.formatAllComments()
    expect(out).toContain('<file path="src/&lt;x&gt;.rs">')
    expect(out).toContain('+ Vec&lt;T&gt; &amp; U')
    expect(out).toContain('a &lt; b &amp;&amp; c &gt; d')
  })

  it('prefixes a deletion-side line with -', async () => {
    // The prefix is the only thing telling the agent whether the quoted line
    // is code it just wrote or code it removed.
    const { result } = await mount([makeComment({ id: 'a', side: 'deletions', lineContent: 'gone()' })])
    expect(result.current.formatAllComments()).toContain('<code>- gone()</code>')
  })

  it('gives a multi-line range one diff line per row', async () => {
    const { result } = await mount([
      makeComment({ id: 'a', lineNumber: 3, endLine: 5, lineContent: 'one\ntwo\nthree' }),
    ])
    const out = result.current.formatAllComments()
    expect(out).toContain('<comment line="3" endLine="5">')
    expect(out).toContain('<code>\n+ one\n+ two\n+ three\n</code>')
  })

  it('hands over the exact selected substring alongside the columns', async () => {
    // selectedText spares the agent recomputing a multi-line substring from
    // column offsets, which is where off-by-ones live.
    const { result } = await mount([
      makeComment({ id: 'a', lineNumber: 3, endLine: 3, startColumn: 4, endColumn: 5, selectedText: 'x' }),
    ])
    const out = result.current.formatAllComments()
    expect(out).toContain('<comment line="3" startColumn="4" endColumn="5">')
    expect(out).toContain('<selected>x</selected>')
  })

  it('emits a column anchor of zero rather than dropping it', async () => {
    // A selection starting at column 0 is ordinary; an `if (startColumn)` test
    // would silently downgrade it to a line-level comment.
    const { result } = await mount([
      makeComment({ id: 'a', startColumn: 0, endColumn: 3, selectedText: 'let' }),
    ])
    expect(result.current.formatAllComments()).toContain('startColumn="0" endColumn="3"')
  })

  it('renders a suggestion as a GitHub-style fence', async () => {
    const { result } = await mount([
      makeComment({ id: 'a', body: 'simpler', suggestion: { newLines: ['let x = 2;', 'ok()'] } }),
    ])
    const out = result.current.formatAllComments()
    expect(out).toContain('<suggestion>\n```suggestion\nlet x = 2;\nok()\n```\n</suggestion>')
  })

  it('omits an empty body instead of emitting a blank line', async () => {
    // A suggestion-only comment has no prose; a stray blank line inside
    // <comment> is noise the agent has to interpret.
    const { result } = await mount([makeComment({ id: 'a', body: '', lineContent: 'let x = 1;', suggestion: { newLines: ['x'] } })])
    const out = result.current.formatAllComments()
    // Assert the shape that IS emitted, not the absence of one concatenation:
    // a negative match also passes if the code line stops rendering entirely.
    expect(out).toContain(
      '<code>+ let x = 1;</code>\n<suggestion>\n```suggestion\nx\n```\n</suggestion>',
    )
  })

  it('declares the schema version it is emitting', async () => {
    // The agent-side skill branches on this; bumping the payload without the
    // version is how a consumer ends up parsing v3 as v2.
    const { result } = await mount([makeComment({ id: 'a' })])
    const out = result.current.formatAllComments()
    expect(out.startsWith('<code-review-comments version="3">')).toBe(true)
    expect(out.endsWith('</code-review-comments>')).toBe(true)
  })
})

describe('copyAllComments', () => {
  it('writes the formatted review to the clipboard', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { result } = await mount([makeComment({ id: 'a', body: 'copied' })])
    await act(async () => {
      await result.current.copyAllComments()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('copied')
  })
})

// A refused write is the failure mode nothing here used to notice: `fetch`
// resolves, `res.json()` returns the error body, and every onSuccess runs on
// it — so the cache gains a comment the server rejected, the reader sees it
// land, and the next 3s poll quietly takes it away again. Each case below
// asserts both halves: the reader is told, and the cache is not corrupted.
describe('a server that says no', () => {
  it('does not add a comment the server refused', async () => {
    const { result } = await mount([])
    refuse = { method: 'POST', status: 403, body: 'review is read-only' }
    await act(async () => {
      result.current.addComment('src/a.rs', 'additions', 1, 1, 'x', 'body')
    })
    await waitFor(() => expect(reported).toHaveLength(1))
    expect(reported[0]).toContain('403')
    // The detail is the part a reader can act on — a 403 alone doesn't say
    // the review is read-only.
    expect(reported[0]).toContain('review is read-only')
    expect(result.current.comments).toHaveLength(0)
  })

  it('keeps a comment the server refused to delete', async () => {
    const { result } = await mount([makeComment({ id: 'c1' })])
    refuse = { method: 'DELETE', status: 500 }
    await act(async () => {
      result.current.removeComment('c1')
    })
    await waitFor(() => expect(reported).toHaveLength(1))
    // The one case with no JSON body to read: the status has to carry it.
    expect(reported[0]).toContain('500')
    expect(result.current.comments.map((c) => c.id)).toEqual(['c1'])
  })

  it('does not show a reply the server refused', async () => {
    const { result } = await mount([makeComment({ id: 'c1' })])
    refuse = { method: 'POST', status: 404, body: 'no such comment' }
    await act(async () => {
      result.current.replyToComment('c1', 'still there?')
    })
    await waitFor(() => expect(reported).toHaveLength(1))
    expect(result.current.comments[0].replies).toHaveLength(0)
  })

  it('leaves a comment unresolved when the resolve was refused', async () => {
    const { result } = await mount([makeComment({ id: 'c1', status: 'open' })])
    refuse = { method: 'PUT', status: 409 }
    await act(async () => {
      result.current.resolveComment('c1')
    })
    await waitFor(() => expect(reported).toHaveLength(1))
    expect(result.current.comments[0].status).toBe('open')
  })

  it('reports a refused draft flush', async () => {
    const { result } = await mount([makeComment({ id: 'c1', status: 'draft' })])
    refuse = { method: 'POST', status: 500 }
    await act(async () => {
      result.current.postDrafts()
    })
    await waitFor(() => expect(reported).toHaveLength(1))
    // Nothing to assert about the cache — this mutation never wrote one
    // optimistically. What it must not do is claim drafts were posted.
    expect(result.current.draftCount).toBe(1)
  })

  it('reports a failed load once per outage, not once per poll', async () => {
    const { result } = await mount([makeComment({ id: 'c1' })])
    refuse = { method: 'GET', status: 500 }
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['comments'] })
    })
    await waitFor(() => expect(reported).toHaveLength(1))
    // Two more failing polls — the reader has already been told, and a strip
    // every three seconds for a server that is simply down is not information.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['comments'] })
      await queryClient.refetchQueries({ queryKey: ['comments'] })
    })
    expect(reported).toHaveLength(1)
    // The comments already on screen survive the outage; a review in progress
    // shouldn't empty out because one poll missed.
    expect(result.current.comments).toHaveLength(1)
  })

  it('reports again after the server recovers and fails a second time', async () => {
    const { result } = await mount([makeComment({ id: 'c1' })])
    refuse = { method: 'GET', status: 500 }
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['comments'] })
    })
    await waitFor(() => expect(reported).toHaveLength(1))
    refuse = null
    await poll(result, 1)
    refuse = { method: 'GET', status: 500 }
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['comments'] })
    })
    await waitFor(() => expect(reported).toHaveLength(2))
  })

  it('mounts without an onError — the argument is optional', async () => {
    server = []
    const rendered = renderHook(() => useComments(), { wrapper })
    await waitFor(() => expect(rendered.result.current.comments).toHaveLength(0))
    refuse = { method: 'POST', status: 500 }
    await act(async () => {
      rendered.result.current.addComment('src/a.rs', 'additions', 1, 1, 'x', 'body')
    })
    // The point is that the missing callback doesn't throw past the mutation.
    await waitFor(() => expect(rendered.result.current.comments).toHaveLength(0))
  })
})
