import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { CommentBubble } from './CommentBubble'
import type { ReviewComment } from '../../types'
import { makeComment } from '../test-utils'

function renderBubble(over: Partial<ReviewComment> = {}) {
  const onDelete = vi.fn()
  const onReply = vi.fn()
  const utils = render(
    <CommentBubble comment={makeComment(over)} onDelete={onDelete} onReply={onReply} />,
  )
  return { onDelete, onReply, ...utils }
}

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

    it('marks a draft as not-yet-posted', () => {
      // A draft is invisible to the listening agent; if it looked like a
      // posted comment the reviewer would think the agent had seen it.
      const { container } = renderBubble({ status: 'draft' })
      expect(screen.getByText('Draft')).toBeInTheDocument()
      expect(container.querySelector('.comment-draft')).toBeTruthy()
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

    it('does not offer to save a reply as a draft', () => {
      // Drafts are a comment-level concept; a "draft reply" has no server
      // representation, so the button must not appear on a reply form.
      renderBubble()
      fireEvent.click(screen.getByRole('button', { name: /Reply/ }))
      expect(screen.queryByRole('button', { name: 'Save as draft' })).toBeNull()
    })
  })
})
