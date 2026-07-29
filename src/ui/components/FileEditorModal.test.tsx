import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { FileEditorModal } from './FileEditorModal'
import { NO_LANG, typeInCodeMirror } from '../test-utils'

const PATH = `src/${NO_LANG}`


function renderModal(over: Partial<React.ComponentProps<typeof FileEditorModal>> = {}) {
  const onClose = vi.fn()
  const onSave = vi.fn(async () => {})
  const utils = render(
    <FileEditorModal
      filePath={PATH}
      initialContents="original"
      onClose={onClose}
      onSave={onSave}
      {...over}
    />,
  )
  return { onClose, onSave, ...utils }
}

const backdrop = (c: HTMLElement) => c.querySelector('.editor-modal-backdrop') as HTMLElement
const modal = (c: HTMLElement) => c.querySelector('.editor-modal') as HTMLElement
const discardStrip = () => screen.queryByText(`Discard unsaved edits to ${PATH}?`)

describe('FileEditorModal — clean', () => {
  it('closes straight away with nothing to lose', () => {
    const { onClose, container } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(discardStrip()).toBeNull()
    expect(backdrop(container)).toBeTruthy()
  })

  it('will not save an unchanged file', () => {
    // A no-op write still broadcasts file-written and refreshes every client.
    const { onSave } = renderModal()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('ignores Cmd/Ctrl-S on an unchanged file', async () => {
    // The shortcut calls the save handler directly and never sees the button's
    // `disabled` state, so the no-op guard has to live in the handler. A
    // reflexive Cmd-S would otherwise broadcast file-written to every client
    // and refresh the diff for no reason.
    const { container, onSave } = renderModal()
    await act(async () => {
      fireEvent.keyDown(modal(container), { key: 's', metaKey: true })
      fireEvent.keyDown(modal(container), { key: 's', ctrlKey: true })
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('shows no unsaved marker', () => {
    renderModal()
    expect(screen.queryByText('• unsaved')).toBeNull()
  })
})

describe('FileEditorModal — unsaved edits', () => {
  it('marks the file dirty as soon as it diverges', () => {
    const { container } = renderModal()
    typeInCodeMirror(container, 'changed')
    expect(screen.getByText('• unsaved')).toBeInTheDocument()
  })

  it('asks before discarding on Cancel instead of closing', () => {
    const { container, onClose } = renderModal()
    typeInCodeMirror(container, 'changed')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(discardStrip()).toBeInTheDocument()
  })

  it('asks before discarding on a backdrop click', () => {
    // The backdrop used to close outright — the one silent path that could
    // drop a reviewer's edits with no prompt at all.
    const { container, onClose } = renderModal()
    typeInCodeMirror(container, 'changed')
    fireEvent.click(backdrop(container))
    expect(onClose).not.toHaveBeenCalled()
    expect(discardStrip()).toBeInTheDocument()
  })

  it('asks before discarding on Escape', () => {
    const { container, onClose } = renderModal()
    typeInCodeMirror(container, 'changed')
    fireEvent.keyDown(modal(container), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(discardStrip()).toBeInTheDocument()
  })

  it('closes on an explicit Discard', () => {
    const { container, onClose } = renderModal()
    typeInCodeMirror(container, 'changed')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('returns to editing on "Keep editing", losing nothing', () => {
    const { container, onClose } = renderModal()
    typeInCodeMirror(container, 'changed')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(discardStrip()).toBeNull()
    expect(screen.getByText('• unsaved')).toBeInTheDocument()
  })

  it('keeps a click inside the modal from reaching the backdrop', () => {
    // Otherwise every click in the editor would read as "close".
    const { container, onClose } = renderModal()
    fireEvent.click(modal(container))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('FileEditorModal — saving', () => {
  it('writes the edited contents and closes', async () => {
    const { container, onSave, onClose } = renderModal()
    typeInCodeMirror(container, 'edited text')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(onSave).toHaveBeenCalledWith('edited text')
    expect(onClose).toHaveBeenCalled()
  })

  it('saves on Cmd/Ctrl-S', async () => {
    const { container, onSave } = renderModal()
    typeInCodeMirror(container, 'edited text')
    await act(async () => {
      fireEvent.keyDown(modal(container), { key: 's', metaKey: true })
    })
    expect(onSave).toHaveBeenCalledWith('edited text')
  })

  it('saves from a layout that reports no Latin key, via the physical key', async () => {
    // A Cyrillic layout (or an active CJK input method) delivers `key: 'ы'` for
    // the physical S. Matching only `key` makes the sole save shortcut in krit
    // unreachable on those keyboards, with no hint as to why.
    const { container, onSave } = renderModal()
    typeInCodeMirror(container, 'edited text')
    await act(async () => {
      fireEvent.keyDown(modal(container), { key: 'ы', code: 'KeyS', metaKey: true })
    })
    expect(onSave).toHaveBeenCalledWith('edited text')
  })

  it('does not save on some other key that merely reports a Latin s', async () => {
    // The pair is OR'd, so neither half may fire on its own for an unrelated
    // physical key with an unrelated character.
    const { container, onSave } = renderModal()
    typeInCodeMirror(container, 'edited text')
    await act(async () => {
      fireEvent.keyDown(modal(container), { key: 'k', code: 'KeyK', metaKey: true })
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('keeps the modal open and shows why when the write fails', async () => {
    // Closing on failure would throw the reviewer's edits away and leave them
    // believing the file was written.
    const onSave = vi.fn(async () => {
      throw new Error('permission denied')
    })
    const { container, onClose } = renderModal({ onSave })
    typeInCodeMirror(container, 'edited text')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('permission denied')).toBeInTheDocument()
    // and the reviewer can try again
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('reseeds both the document and the baseline when the parent reloads the file', () => {
    // A fresh load is a fresh session. Keeping the old text would show the
    // reader stale content; keeping the old baseline would measure dirtiness
    // against text nobody is looking at and call it their unsaved work.
    const { container, rerender, onSave } = renderModal()
    rerender(
      <FileEditorModal
        filePath={PATH}
        initialContents="reloaded from disk"
        onClose={vi.fn()}
        onSave={onSave}
      />,
    )
    expect(container.querySelector('.cm-content')?.textContent).toContain('reloaded from disk')
    expect(screen.queryByText('• unsaved')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
