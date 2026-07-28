import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SelectionPill } from './SelectionPill'

function renderPill(x = 100, y = 100) {
  const onComment = vi.fn()
  const onDelete = vi.fn()
  const utils = render(<SelectionPill x={x} y={y} onComment={onComment} onDelete={onDelete} />)
  return { onComment, onDelete, ...utils }
}

describe('SelectionPill', () => {
  it('routes Comment to onComment only', () => {
    // These two actions are adjacent and one of them edits the working tree.
    // Swapping them deletes text the reviewer meant to annotate.
    const { onComment, onDelete } = renderPill()
    fireEvent.click(screen.getByRole('button', { name: /Comment/ }))
    expect(onComment).toHaveBeenCalledTimes(1)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('routes Delete to onDelete only', () => {
    const { onComment, onDelete } = renderPill()
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onComment).not.toHaveBeenCalled()
  })

  it('swallows mousedown so the click does not clear the text selection', () => {
    // The handlers read the live selection; browsers collapse it on mousedown
    // elsewhere, so without preventDefault both actions get an empty range.
    const { container } = renderPill()
    const pill = container.querySelector('.selection-pill') as HTMLElement
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    pill.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('positions itself at the selection when there is room', () => {
    const { container } = renderPill(120, 240)
    const pill = container.querySelector('.selection-pill') as HTMLElement
    expect(pill.style.position).toBe('fixed')
    expect(pill.style.left).toBe('120px')
    expect(pill.style.top).toBe('240px')
  })

  it('clamps a selection ending past the right edge back on screen', () => {
    // A selection at the end of a long line anchors the pill off-viewport;
    // an unclamped pill is unclickable and the reviewer just loses the action.
    const { container } = renderPill(window.innerWidth + 500, 100)
    const pill = container.querySelector('.selection-pill') as HTMLElement
    expect(parseFloat(pill.style.left)).toBeLessThan(window.innerWidth)
    expect(parseFloat(pill.style.left)).toBeGreaterThanOrEqual(8)
  })

  it('never places itself above the top margin', () => {
    const { container } = renderPill(-500, -500)
    const pill = container.querySelector('.selection-pill') as HTMLElement
    expect(parseFloat(pill.style.left)).toBe(8)
    expect(parseFloat(pill.style.top)).toBe(8)
  })
})
