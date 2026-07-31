import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { CommentBubble } from './CommentBubble'
import type { ReviewComment } from '../../types'
import { makeComment } from '../test-utils'

function renderBubble(over: Partial<ReviewComment> = {}, onEdit?: (id: string, body: string) => void) {
  const onDelete = vi.fn()
  const onReply = vi.fn()
  const utils = render(
    <CommentBubble
      comment={makeComment(over)}
      onDelete={onDelete}
      onReply={onReply}
      onEdit={onEdit}
    />,
  )
  return { onDelete, onReply, ...utils }
}

const queuedBadge = () => screen.getByRole('button', { name: /Queued/ })
const editor = () => screen.getByLabelText('Edit queued comment')

describe('CommentBubble', () => {
  it('shows the comment body', () => {
    renderBubble({ body: 'this needs a test' })
    expect(screen.getByText('this needs a test')).toBeInTheDocument()
  })

  it('deletes by id', () => {
    // The wrong id here deletes someone else's comment, irrecoverably.
    const { onDelete } = renderBubble({ id: 'c-target' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }))
    expect(onDelete).toHaveBeenCalledWith('c-target')
  })

  it('carries an anchor id so the tracker can jump to it', () => {
    const { container } = renderBubble({ id: 'c9' })
    expect(container.querySelector('#comment-c9')).toBeTruthy()
  })

  describe('status badges', () => {
    it('marks a resolved comment', () => {
      const { container } = renderBubble({ status: 'resolved' })
      expect(screen.getByText('Resolved')).toBeInTheDocument()
      expect(container.querySelector('.comment-resolved')).toBeTruthy()
    })

    it('marks a queued comment as not-yet-posted', () => {
      // A queued comment is invisible to the listening agent; if it looked like a
      // posted comment the reviewer would think the agent had seen it.
      const { container } = renderBubble({ status: 'queued' })
      expect(screen.getByText('Queued')).toBeInTheDocument()
      expect(container.querySelector('.comment-queued')).toBeTruthy()
    })

    it('shows neither badge on a plain open comment', () => {
      renderBubble({ status: 'open' })
      expect(screen.queryByText('Resolved')).toBeNull()
      expect(screen.queryByText('Draft')).toBeNull()
    })

    it('flags an outdated comment whose anchor drifted', () => {
      renderBubble({ outdated: true })
      expect(screen.getByText('Outdated')).toBeInTheDocument()
    })

    it('suppresses "Outdated" once the comment is resolved', () => {
      // A resolved comment is done; stale-anchor noise on it is just clutter.
      renderBubble({ outdated: true, status: 'resolved' })
      expect(screen.queryByText('Outdated')).toBeNull()
    })
  })

  describe('line range', () => {
    it('shows the span for a multi-line comment', () => {
      renderBubble({ lineNumber: 10, endLine: 14 })
      expect(screen.getByText('L10–L14')).toBeInTheDocument()
    })

    it('omits the span when the comment covers one line', () => {
      // endLine === lineNumber is how a single-line comment is stored; showing
      // "L10–L10" would imply a range the reviewer never selected.
      const { container } = renderBubble({ lineNumber: 10, endLine: 10 })
      expect(container.querySelector('.comment-bubble-range')).toBeNull()
    })

    it('treats a comment with no endLine at all as single-line', () => {
      // endLine is optional in the schema so pre-multiline comment stores can
      // still be read; a missing one must not render as a range.
      const { container } = renderBubble({ lineNumber: 10, endLine: undefined })
      expect(container.querySelector('.comment-bubble-range')).toBeNull()
    })
  })

  describe('suggested rewrite', () => {
    it('renders the original lines as removals and the rewrite as additions', () => {
      const { container } = renderBubble({
        lineContent: 'old one\nold two',
        suggestion: { newLines: ['new one'] },
      })
      const removed = container.querySelectorAll('.comment-suggestion-old .del')
      const added = container.querySelectorAll('.comment-suggestion-new .add')
      expect([...removed].map((n) => n.textContent)).toEqual(['- old one', '- old two'])
      expect([...added].map((n) => n.textContent)).toEqual(['+ new one'])
    })

    it('renders nothing suggestion-shaped for a plain comment', () => {
      const { container } = renderBubble()
      expect(container.querySelector('.comment-suggestion')).toBeNull()
    })
  })

  describe('replies', () => {
    it('attributes a user reply to "You" and an agent reply to "Agent"', () => {
      // Getting this backwards makes the agent look like it is quoting the
      // reviewer back at them, and vice versa.
      const { container } = renderBubble({
        replies: [
          { id: 'r1', body: 'mine', createdAt: Date.now(), author: 'user' },
          { id: 'r2', body: 'theirs', createdAt: Date.now(), author: 'agent' },
        ],
      })
      const replies = [...container.querySelectorAll('.comment-reply')]
      expect(within(replies[0] as HTMLElement).getByText('You')).toBeInTheDocument()
      expect(within(replies[0] as HTMLElement).getByText('mine')).toBeInTheDocument()
      expect(within(replies[1] as HTMLElement).getByText('Agent')).toBeInTheDocument()
      expect(replies[0]).toHaveClass('comment-reply-user')
      expect(replies[1]).toHaveClass('comment-reply-agent')
    })

    it('treats a reply with no author as the agent', () => {
      // Replies persisted before the `author` field existed were all the
      // bot's; defaulting them to "You" would rewrite the reviewer's history.
      const { container } = renderBubble({
        replies: [{ id: 'r1', body: 'legacy', createdAt: Date.now() }],
      })
      expect(screen.getByText('Agent')).toBeInTheDocument()
      expect(container.querySelector('.comment-reply')).toHaveClass('comment-reply-agent')
    })

    it('renders no reply list when there are none', () => {
      const { container } = renderBubble()
      expect(container.querySelector('.comment-replies')).toBeNull()
    })
  })

  describe('replying', () => {
    it('opens a reply form, posts against this comment, and closes', () => {
      const { onReply } = renderBubble({ id: 'c-reply' })
      fireEvent.click(screen.getByRole('button', { name: /Reply/ }))
      const field = screen.getByPlaceholderText('Leave a review comment...')
      fireEvent.change(field, { target: { value: 'good point' } })
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
      expect(onReply).toHaveBeenCalledWith('c-reply', 'good point')
      // The form must close on submit, or a second click double-posts.
      expect(screen.queryByPlaceholderText('Leave a review comment...')).toBeNull()
    })

    it('closes the reply form on cancel without posting', () => {
      const { onReply } = renderBubble()
      fireEvent.click(screen.getByRole('button', { name: /Reply/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onReply).not.toHaveBeenCalled()
      expect(screen.queryByPlaceholderText('Leave a review comment...')).toBeNull()
    })

    it('does not offer to queue a reply', () => {
      // Queueing is a comment-level concept; a "queued reply" has no server
      // representation, so the button must not appear on a reply form.
      renderBubble()
      fireEvent.click(screen.getByRole('button', { name: /Reply/ }))
      expect(screen.queryByRole('button', { name: 'Queue comment' })).toBeNull()
    })
  })
})

describe('editing a queued comment', () => {
  it('opens the editor from the Queued badge, seeded with the current text', () => {
    const onEdit = vi.fn()
    renderBubble({ status: 'queued', body: 'first thoughts' }, onEdit)
    fireEvent.click(queuedBadge())
    expect(editor()).toHaveValue('first thoughts')
  })

  it('saves the rewritten body against the right comment', async () => {
    const onEdit = vi.fn()
    renderBubble({ id: 'c-target', status: 'queued', body: 'first thoughts' }, onEdit)
    fireEvent.click(queuedBadge())
    fireEvent.change(editor(), { target: { value: '  second thoughts  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // Trimmed, and against the id the badge belongs to — an edit filed against
    // another comment is invisibly wrong.
    expect(onEdit).toHaveBeenCalledWith('c-target', 'second thoughts')
    // The editor closes on the save resolving, not on the click.
    await waitFor(() => expect(screen.queryByLabelText('Edit queued comment')).not.toBeInTheDocument())
  })

  it('saves on Cmd/Ctrl-Enter without reaching for the mouse', () => {
    const onEdit = vi.fn()
    renderBubble({ status: 'queued', body: 'a' }, onEdit)
    fireEvent.click(queuedBadge())
    fireEvent.change(editor(), { target: { value: 'b' } })
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true })
    expect(onEdit).toHaveBeenCalledWith('c1', 'b')
  })

  it('refuses to save an empty body', () => {
    // An empty comment renders as an anchor with nothing in it, which reads as
    // a bug. Deleting is the other button.
    const onEdit = vi.fn()
    renderBubble({ status: 'queued', body: 'something' }, onEdit)
    fireEvent.click(queuedBadge())
    fireEvent.change(editor(), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true })
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('asks before dropping an edit, and closes silently when nothing changed', () => {
    const onEdit = vi.fn()
    renderBubble({ status: 'queued', body: 'unchanged' }, onEdit)
    fireEvent.click(queuedBadge())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Edit queued comment')).not.toBeInTheDocument()

    fireEvent.click(queuedBadge())
    fireEvent.change(editor(), { target: { value: 'typed something' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/Discard your changes/)
    expect(screen.getByLabelText('Edit queued comment')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByLabelText('Edit queued comment')).not.toBeInTheDocument()
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('answers the discard question from the keyboard', () => {
    // Escape that asks a question the keyboard cannot answer is the dead end a
    // native dialog would have been.
    const onEdit = vi.fn()
    renderBubble({ status: 'queued', body: 'x' }, onEdit)
    fireEvent.click(queuedBadge())
    fireEvent.change(editor(), { target: { value: 'y' } })
    fireEvent.keyDown(editor(), { key: 'Escape' })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.keyDown(editor(), { key: 'Escape' })
    expect(screen.queryByLabelText('Edit queued comment')).not.toBeInTheDocument()
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('offers no editing on a posted comment, whatever its status', () => {
    // A posted comment has already reached the agent and a body change
    // broadcasts nothing, so editing one would leave the two sides reading
    // different text with nothing to say so.
    const onEdit = vi.fn()
    renderBubble({ status: 'open', body: 'posted' }, onEdit)
    expect(screen.queryByRole('button', { name: /Queued/ })).not.toBeInTheDocument()
    renderBubble({ status: 'resolved', body: 'done' }, onEdit)
    expect(screen.queryByRole('button', { name: /Queued/ })).not.toBeInTheDocument()
  })

  it('drops an open editor when the same instance is handed a different comment', () => {
    // Pierre keys line annotations by array *index*, so deleting a comment
    // earlier in the file shifts every later one into its neighbour's slot and
    // React reuses this component for a different comment. Carrying the editor
    // across files one comment's text under another comment's id.
    const onEdit = vi.fn()
    const { rerender } = render(
      <CommentBubble
        comment={makeComment({ id: 'first', status: 'queued', body: 'about the first' })}
        onDelete={vi.fn()}
        onReply={vi.fn()}
        onEdit={onEdit}
      />,
    )
    fireEvent.click(queuedBadge())
    fireEvent.change(editor(), { target: { value: 'rewritten for the first' } })
    rerender(
      <CommentBubble
        comment={makeComment({ id: 'second', status: 'queued', body: 'about the second' })}
        onDelete={vi.fn()}
        onReply={vi.fn()}
        onEdit={onEdit}
      />,
    )
    expect(screen.queryByLabelText('Edit queued comment')).not.toBeInTheDocument()
    expect(screen.getByText('about the second')).toBeInTheDocument()
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('closes the editor if the comment is posted while it is open', () => {
    // "Post queued" and Done reviewing both flip the status from under an open
    // editor. Saving after that would rewrite a comment the agent has already
    // read, and nothing on this route tells it the text changed.
    const onEdit = vi.fn()
    const { rerender } = render(
      <CommentBubble
        comment={makeComment({ id: 'c1', status: 'queued', body: 'still mine' })}
        onDelete={vi.fn()}
        onReply={vi.fn()}
        onEdit={onEdit}
      />,
    )
    fireEvent.click(queuedBadge())
    expect(editor()).toBeInTheDocument()
    rerender(
      <CommentBubble
        comment={makeComment({ id: 'c1', status: 'open', body: 'still mine' })}
        onDelete={vi.fn()}
        onReply={vi.fn()}
        onEdit={onEdit}
      />,
    )
    expect(screen.queryByLabelText('Edit queued comment')).not.toBeInTheDocument()
    expect(screen.getByText('still mine')).toBeInTheDocument()
  })

  it('keeps the text on screen when the save is refused', async () => {
    // The refusal that matters is losing the race to "Post queued": the server
    // rejects the write (expectStatus) and the reviewer's rewrite exists only
    // in this textarea. Closing on the click would be the one unrecoverable
    // outcome.
    const onEdit = vi.fn().mockRejectedValue(new Error('409'))
    renderBubble({ status: 'queued', body: 'original' }, onEdit)
    fireEvent.click(queuedBadge())
    fireEvent.change(editor(), { target: { value: 'my rewrite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/didn.t save/i))
    expect(editor()).toHaveValue('my rewrite')
  })

  it('renders the badge as plain text where no edit handler is wired', () => {
    renderBubble({ status: 'queued', body: 'read only' })
    expect(screen.getByText('Queued')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Queued/ })).not.toBeInTheDocument()
  })
})
