import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommentForm } from './CommentForm'
import { NO_LANG, modEnter } from '../test-utils'


function renderForm(props: Partial<React.ComponentProps<typeof CommentForm>> = {}) {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  const utils = render(
    <CommentForm filePath={NO_LANG} onSubmit={onSubmit} onCancel={onCancel} {...props} />,
  )
  return { onSubmit, onCancel, ...utils }
}

const body = () => screen.getByPlaceholderText('Leave a review comment...')
const submitBtn = () => screen.getByRole('button', { name: 'Comment' })


describe('CommentForm — plain comment', () => {
  it('posts the typed body', () => {
    const { onSubmit } = renderForm()
    fireEvent.change(body(), { target: { value: 'needs a test' } })
    fireEvent.click(submitBtn())
    // One argument, not two: a plain comment must not carry a suggestion
    // payload, or the agent renders an empty ```suggestion block.
    expect(onSubmit).toHaveBeenCalledWith('needs a test')
    expect(onSubmit.mock.calls[0]).toHaveLength(1)
  })

  it('trims surrounding whitespace off the posted body', () => {
    const { onSubmit } = renderForm()
    fireEvent.change(body(), { target: { value: '  spaced  ' } })
    fireEvent.click(submitBtn())
    expect(onSubmit).toHaveBeenCalledWith('spaced')
  })

  it('refuses to post an empty or whitespace-only comment', () => {
    // An empty comment is invisible in the tracker but still counts toward the
    // "Done reviewing (N)" total, so it would misreport the review's size.
    const { onSubmit } = renderForm()
    expect(submitBtn()).toBeDisabled()
    fireEvent.change(body(), { target: { value: '   ' } })
    expect(submitBtn()).toBeDisabled()
    fireEvent.click(submitBtn())
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.change(body(), { target: { value: 'x' } })
    expect(submitBtn()).toBeEnabled()
  })

  it('refuses an empty comment submitted by keyboard, not just by button', () => {
    // Cmd-Enter calls the submit handler directly and never consults the
    // button's `disabled` state, so the guard has to live in the handler.
    // Without this the disabled attribute is the only thing standing between
    // an impatient keystroke and an empty comment on the server.
    const { onSubmit } = renderForm()
    fireEvent.keyDown(body(), { key: 'Enter', metaKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.change(body(), { target: { value: '   ' } })
    fireEvent.keyDown(body(), { key: 'Enter', metaKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('cancels without posting', () => {
    const { onSubmit, onCancel } = renderForm()
    fireEvent.change(body(), { target: { value: 'never mind' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits on Cmd/Ctrl-Enter but not on a bare Enter', () => {
    // Bare Enter has to stay a newline — reviewers write multi-line comments.
    const { onSubmit } = renderForm()
    fireEvent.change(body(), { target: { value: 'ship it' } })
    fireEvent.keyDown(body(), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(body(), { key: 'Enter', metaKey: true })
    expect(onSubmit).toHaveBeenCalledWith('ship it')
  })

  it('cancels on Escape in the body field', () => {
    const { onCancel } = renderForm()
    fireEvent.keyDown(body(), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('reports every keystroke so a lifted draft survives a remount', () => {
    // CodeViewWrapper's `pending` map is the only place in-progress typing
    // lives; if the form stops reporting, a remount silently eats the draft.
    const onBodyChange = vi.fn()
    renderForm({ onBodyChange })
    fireEvent.change(body(), { target: { value: 'ab' } })
    expect(onBodyChange).toHaveBeenLastCalledWith('ab')
  })

  it('offers "Save as draft" only when the caller supports drafts', () => {
    // Reply forms have no draft concept; showing the button there would post
    // a comment the reviewer expected to stay private.
    renderForm()
    expect(screen.queryByRole('button', { name: 'Save as draft' })).toBeNull()
  })

  it('routes "Save as draft" to onSaveDraft, never to onSubmit', () => {
    const onSaveDraft = vi.fn()
    const { onSubmit } = renderForm({ onSaveDraft })
    fireEvent.change(body(), { target: { value: 'private note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }))
    expect(onSaveDraft).toHaveBeenCalledWith('private note')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('CommentForm — suggest mode', () => {
  it('toggles into suggest mode and relabels the primary action', () => {
    const onSuggestModeChange = vi.fn()
    renderForm({ originalLines: 'const a = 1', onSuggestModeChange })
    fireEvent.click(screen.getByRole('button', { name: 'Suggest edit' }))
    expect(onSuggestModeChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: 'Suggest rewrite' })).toBeInTheDocument()
    // The body field demotes to an optional description — the rewrite is now
    // the primary input.
    expect(screen.getByPlaceholderText('Optional description...')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel suggest' }))
    expect(onSuggestModeChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument()
  })

  it('sends the edited rewrite split into one entry per line', () => {
    const { onSubmit } = renderForm({
      originalLines: 'const a = 1',
      initialSuggestMode: true,
      initialSuggestionText: 'const a = 2\nconst b = 3',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Suggest rewrite' }))
    expect(onSubmit).toHaveBeenCalledWith('', { newLines: ['const a = 2', 'const b = 3'] })
  })

  it('drops the suggestion payload when the rewrite was never edited', () => {
    // An unchanged suggestion renders to the agent as a no-op diff; the
    // reviewer's description is the only real content, so post it as a
    // plain comment instead.
    const { onSubmit } = renderForm({
      originalLines: 'const a = 1',
      initialSuggestMode: true,
      initialSuggestionText: 'const a = 1',
    })
    fireEvent.change(screen.getByPlaceholderText('Optional description...'), {
      target: { value: 'why this line?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Suggest rewrite' }))
    expect(onSubmit).toHaveBeenCalledWith('why this line?')
    expect(onSubmit.mock.calls[0]).toHaveLength(1)
  })

  it('refuses to post an unchanged rewrite with no description', () => {
    // Nothing was said and nothing was changed — posting would create an
    // empty comment anchored to a line for no reason.
    const { onSubmit } = renderForm({
      originalLines: 'const a = 1',
      initialSuggestMode: true,
      initialSuggestionText: 'const a = 1',
    })
    const btn = screen.getByRole('button', { name: 'Suggest rewrite' })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('refuses an unchanged, undescribed rewrite submitted from the editor', () => {
    // Cmd-Enter inside the rewrite editor is the natural way to post from
    // suggest mode and bypasses the disabled button entirely.
    const { onSubmit, container } = renderForm({
      originalLines: 'const a = 1',
      initialSuggestMode: true,
      initialSuggestionText: 'const a = 1',
    })
    modEnter(container)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('posts the rewrite on Cmd/Ctrl-Enter from inside the editor', () => {
    // Proves the keymap above is actually wired — without this, the negative
    // test could pass simply because the keystroke went nowhere.
    const { onSubmit, container } = renderForm({
      originalLines: 'const a = 1',
      initialSuggestMode: true,
      initialSuggestionText: 'const a = 2',
    })
    modEnter(container)
    expect(onSubmit).toHaveBeenCalledWith('', { newLines: ['const a = 2'] })
  })

  it('allows posting an edited rewrite with no description', () => {
    // The rewrite itself is the content; forcing prose would be busywork.
    const { onSubmit } = renderForm({
      originalLines: 'const a = 1',
      initialSuggestMode: true,
      initialSuggestionText: 'const a = 2',
    })
    expect(screen.getByRole('button', { name: 'Suggest rewrite' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest rewrite' }))
    expect(onSubmit).toHaveBeenCalledWith('', { newLines: ['const a = 2'] })
  })

  it('sends the same payload through "Save as draft"', () => {
    const onSaveDraft = vi.fn()
    renderForm({
      originalLines: 'a',
      initialSuggestMode: true,
      initialSuggestionText: 'b',
      onSaveDraft,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }))
    expect(onSaveDraft).toHaveBeenCalledWith('', { newLines: ['b'] })
  })

  it('seeds the rewrite from the selected lines', () => {
    // Suggesting starts from what is there — an empty editor would make the
    // reviewer retype the line before changing one character of it.
    const { container } = renderForm({
      originalLines: 'const a = 1',
      initialSuggestMode: true,
    })
    expect(container.querySelector('.cm-content')?.textContent).toContain('const a = 1')
  })
})
