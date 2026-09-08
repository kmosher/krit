import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { OrphanCommentPanel } from './OrphanCommentPanel'
import { makeComment } from '../test-utils'

function renderPanel(over: Parameters<typeof makeComment>[0] = {}) {
  const onClose = vi.fn()
  const utils = render(
    <OrphanCommentPanel
      filePath="gone.ts"
      comments={[makeComment({ id: 'c1', filePath: 'gone.ts', ...over })]}
      focusId="c1"
      onClose={onClose}
      onDelete={vi.fn()}
      onReply={vi.fn()}
    />,
  )
  return { onClose, ...utils }
}

describe('OrphanCommentPanel', () => {
  it("shows the agent's replies, which is the only place they can be read", () => {
    renderPanel({
      replies: [{ id: 'r1', body: 'rewrote it as you asked', author: 'agent', createdAt: 1 }],
    })
    expect(screen.getByText('rewrote it as you asked')).toBeInTheDocument()
  })

  it('keeps the anchored source line, since the file is off the surface', () => {
    renderPanel({ lineContent: 'const x = 1' })
    expect(screen.getByText('const x = 1')).toBeInTheDocument()
  })

  it('closes on Escape', () => {
    const { onClose } = renderPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
