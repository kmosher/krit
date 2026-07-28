import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { CommentTracker } from './CommentTracker'
import type { ReviewComment } from '../../types'

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    filePath: 'src/ui/components/Toolbar.tsx',
    side: 'additions',
    lineNumber: 12,
    lineContent: 'x',
    body: 'a note',
    status: 'open',
    createdAt: 1_000,
    replies: [],
    ...over,
  }
}

const rows = (c: HTMLElement) => [...c.querySelectorAll('.ct-item')] as HTMLElement[]

describe('CommentTracker', () => {
  it('renders nothing at all when there are no comments', () => {
    // The sidebar is meant to be absent, not an empty box taking up width.
    const { container } = render(<CommentTracker comments={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists newest first', () => {
    // Reviewers work off the bottom of their own trail; oldest-first buries
    // the comment they just wrote under everything else.
    const { container } = render(
      <CommentTracker
        comments={[
          comment({ id: 'old', body: 'older note', createdAt: 100 }),
          comment({ id: 'new', body: 'newer note', createdAt: 900 }),
        ]}
      />,
    )
    expect(rows(container).map((r) => r.textContent)).toEqual([
      expect.stringContaining('newer note'),
      expect.stringContaining('older note'),
    ])
  })

  it('labels each row with the file basename and line', () => {
    render(<CommentTracker comments={[comment({ lineNumber: 42 })]} />)
    expect(screen.getByText('Toolbar.tsx:42')).toBeInTheDocument()
  })

  it('shows the line span for a multi-line comment', () => {
    render(<CommentTracker comments={[comment({ lineNumber: 12, endLine: 20 })]} />)
    expect(screen.getByText('Toolbar.tsx:12–20')).toBeInTheDocument()
  })

  it('omits the span when the comment covers a single line', () => {
    render(<CommentTracker comments={[comment({ lineNumber: 12, endLine: 12 })]} />)
    expect(screen.getByText('Toolbar.tsx:12')).toBeInTheDocument()
  })

  it('truncates a long body to one line', () => {
    // Rows are fixed-height for the windowing math; a wrapping body would put
    // every row below it at the wrong scroll offset.
    render(<CommentTracker comments={[comment({ body: 'first line\nsecond line' })]} />)
    expect(screen.getByText('first line')).toBeInTheDocument()
    expect(screen.queryByText(/second line/)).toBeNull()
  })

  describe('status counts', () => {
    it('classifies a replied comment separately from an open one', () => {
      // "Replied" is the reviewer's cue that the agent has answered and the
      // thread needs another look; folding it into "open" hides that.
      render(
        <CommentTracker
          comments={[
            comment({ id: 'a', status: 'open' }),
            comment({
              id: 'b',
              status: 'open',
              replies: [{ id: 'r', body: 'ack', createdAt: 1, author: 'agent' }],
            }),
          ]}
        />,
      )
      expect(screen.getByText('1 open')).toBeInTheDocument()
      expect(screen.getByText('1 replied')).toBeInTheDocument()
    })

    it('counts a resolved comment as resolved even when it has replies', () => {
      render(
        <CommentTracker
          comments={[
            comment({
              status: 'resolved',
              replies: [{ id: 'r', body: 'fixed', createdAt: 1, author: 'agent' }],
            }),
          ]}
        />,
      )
      expect(screen.getByText('1 resolved')).toBeInTheDocument()
      expect(screen.queryByText(/replied/)).toBeNull()
    })

    it('counts a draft as a draft even when it has replies', () => {
      render(
        <CommentTracker
          comments={[
            comment({
              status: 'draft',
              replies: [{ id: 'r', body: 'hm', createdAt: 1, author: 'agent' }],
            }),
          ]}
        />,
      )
      expect(screen.getByText('1 draft')).toBeInTheDocument()
      expect(screen.queryByText(/replied/)).toBeNull()
    })

    it('omits a zero count rather than printing "0 resolved"', () => {
      render(<CommentTracker comments={[comment()]} />)
      expect(screen.getByText('1 open')).toBeInTheDocument()
      expect(screen.queryByText(/resolved/)).toBeNull()
      expect(screen.queryByText(/draft/)).toBeNull()
    })

    it('marks a resolved row so it reads as done', () => {
      const { container } = render(<CommentTracker comments={[comment({ status: 'resolved' })]} />)
      expect(rows(container)[0]).toHaveClass('ct-item-resolved')
    })
  })

  describe('navigation', () => {
    it('jumps to the clicked comment instead of following the anchor', () => {
      // The diff pane is virtualized, so a raw #hash navigation lands nowhere;
      // onJump is what actually scrolls the comment into view.
      const onJump = vi.fn()
      const target = comment({ id: 'c-target', body: 'jump here' })
      const { container } = render(
        <CommentTracker comments={[target, comment({ id: 'other', createdAt: 5 })]} onJump={onJump} />,
      )
      const link = within(rows(container)[0]).getByRole('link')
      const ev = fireEvent.click(link)
      expect(onJump).toHaveBeenCalledTimes(1)
      expect(onJump.mock.calls[0][0]).toMatchObject({ id: 'c-target' })
      expect(ev).toBe(false) // preventDefault() was called
    })

    it('falls back to the plain anchor when no jump handler is wired', () => {
      const { container } = render(<CommentTracker comments={[comment({ id: 'c7' })]} />)
      const link = within(rows(container)[0]).getByRole('link')
      expect(link).toHaveAttribute('href', '#comment-c7')
      // Nothing intercepts it, so the browser's own hash navigation runs.
      expect(fireEvent.click(link)).toBe(true)
    })
  })

  describe('deleting', () => {
    it('deletes by id without also triggering the row jump', () => {
      // The delete button sits inside the link; letting the click bubble would
      // scroll to a comment that is being removed.
      const onDelete = vi.fn()
      const onJump = vi.fn()
      render(
        <CommentTracker comments={[comment({ id: 'c-del' })]} onDelete={onDelete} onJump={onJump} />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }))
      expect(onDelete).toHaveBeenCalledWith('c-del')
      expect(onJump).not.toHaveBeenCalled()
    })

    it('hides the delete affordance when deletion is not offered', () => {
      render(<CommentTracker comments={[comment()]} />)
      expect(screen.queryByRole('button', { name: 'Delete comment' })).toBeNull()
    })
  })

  it('sizes the list to the full comment count even while windowing', () => {
    // The scroll height comes from the total, not the rendered slice —
    // otherwise the scrollbar stops short and later rows are unreachable.
    const many = Array.from({ length: 50 }, (_, i) =>
      comment({ id: `c${i}`, createdAt: 1000 - i }),
    )
    const { container } = render(<CommentTracker comments={many} />)
    const list = container.querySelector('.ct-list') as HTMLElement
    expect(list.style.height).toBe(`${50 * 64}px`)
    // Only the window (plus overscan) is actually in the DOM.
    expect(rows(container).length).toBeLessThan(50)
  })
})
