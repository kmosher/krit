import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Toolbar } from './Toolbar'

type Props = React.ComponentProps<typeof Toolbar>

function renderToolbar(over: Partial<Props> = {}) {
  const spies = {
    onDiffStyleChange: vi.fn(),
    onDiffOptionsChange: vi.fn(),
    onDefaultTabSizeChange: vi.fn(),
    onBrowserChange: vi.fn(),
    onCopyComments: vi.fn(async () => {}),
    onSubmitReview: vi.fn(async () => 'stays-open' as const),
    onRefreshModeChange: vi.fn(),
    onRefresh: vi.fn(),
    onPostQueued: vi.fn(),
  }
  const base: Props = {
    repoName: 'krit',
    branch: 'main',
    fileCount: 3,
    additions: 10,
    deletions: 2,
    commentCount: 0,
    diffStyle: 'split',
    diffOptions: { staged: false, untracked: false, scope: 'uncommitted' },
    defaultTabSize: 4,
    customMode: false,
    watcherCount: 0,
    agentCount: 0,
    submittedAt: null,
    refreshMode: 'live-unless-active',
    staleCount: 0,
    queuedCount: 0,
    ...spies,
  }
  const utils = render(<Toolbar {...base} {...over} />)
  return { ...spies, ...utils }
}

const openSettings = () => fireEvent.click(screen.getByTitle('Settings'))

describe('Toolbar — diff style', () => {
  it('requests split and unified with the matching style', () => {
    const { onDiffStyleChange } = renderToolbar({ diffStyle: 'unified' })
    fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    expect(onDiffStyleChange).toHaveBeenCalledWith('split')
    fireEvent.click(screen.getByRole('button', { name: 'Unified' }))
    expect(onDiffStyleChange).toHaveBeenCalledWith('unified')
  })

  it('marks the active style so the reviewer can see which view they are in', () => {
    renderToolbar({ diffStyle: 'unified' })
    expect(screen.getByRole('button', { name: 'Unified' })).toHaveClass('btn-active')
    expect(screen.getByRole('button', { name: 'Split' })).not.toHaveClass('btn-active')
  })
})

describe('Toolbar — refresh', () => {
  it('refreshes on click', () => {
    const { onRefresh } = renderToolbar()
    fireEvent.click(screen.getByTitle('Refresh the diff'))
    expect(onRefresh).toHaveBeenCalled()
  })

  it('surfaces how many files are waiting when refresh is deferred', () => {
    // In manual/live-unless-active mode this count is the only signal that
    // the diff on screen is behind the working tree.
    renderToolbar({ staleCount: 2 })
    const btn = screen.getByTitle('2 files changed on disk — click to refresh')
    expect(btn).toHaveTextContent('2 changed')
    expect(btn).toHaveClass('btn-refresh-stale')
  })

  it('singularizes the stale-file wording', () => {
    renderToolbar({ staleCount: 1 })
    expect(screen.getByTitle('1 file changed on disk — click to refresh')).toBeInTheDocument()
  })
})

describe('Toolbar — settings menu', () => {
  it('stays closed until asked', () => {
    renderToolbar()
    expect(screen.queryByText('Live refresh')).toBeNull()
    openSettings()
    expect(screen.getByText('Live refresh')).toBeInTheDocument()
  })

  it('toggles "Show staged" without dropping the other diff option', () => {
    // The callback replaces the whole options object; forgetting to spread
    // silently resets `untracked` every time staged is toggled.
    const { onDiffOptionsChange } = renderToolbar({
      diffOptions: { staged: false, untracked: true, scope: 'uncommitted' },
    })
    openSettings()
    fireEvent.click(screen.getByLabelText('Show staged'))
    expect(onDiffOptionsChange).toHaveBeenCalledWith({ staged: true, untracked: true, scope: 'uncommitted' })
  })

  it('switches the scope and keeps the other diff options', () => {
    const { onDiffOptionsChange } = renderToolbar({
      diffOptions: { staged: false, untracked: true, scope: 'uncommitted' },
    })
    openSettings()
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'branch' } })
    expect(onDiffOptionsChange).toHaveBeenCalledWith({
      staged: false,
      untracked: true,
      scope: 'branch',
    })
  })

  it('disables "Show staged" in the branch scope instead of ignoring it', () => {
    // A ref-to-working-tree diff spans the index whatever the toggle says. Left
    // live it would read as a control that does nothing; shown unchecked it
    // would read as "staged changes are excluded", which is worse.
    renderToolbar({
      diffOptions: { staged: false, untracked: true, scope: 'branch' },
    })
    openSettings()
    const staged = screen.getByLabelText('Show staged') as HTMLInputElement
    expect(staged.disabled).toBe(true)
    expect(staged.checked).toBe(true)
  })

  it('toggles "Show untracked" without dropping the other diff option', () => {
    const { onDiffOptionsChange } = renderToolbar({
      diffOptions: { staged: true, untracked: true, scope: 'uncommitted' },
    })
    openSettings()
    fireEvent.click(screen.getByLabelText('Show untracked'))
    expect(onDiffOptionsChange).toHaveBeenCalledWith({ staged: true, untracked: false, scope: 'uncommitted' })
  })

  it('hides the git-diff options in custom mode', () => {
    // Custom mode diffs content the server was handed directly — staged and
    // untracked are meaningless there and would do nothing if clicked.
    renderToolbar({ customMode: true })
    openSettings()
    expect(screen.queryByLabelText('Show staged')).toBeNull()
    expect(screen.queryByLabelText('Show untracked')).toBeNull()
    expect(screen.getByText('Live refresh')).toBeInTheDocument()
  })

  it('changes the live-refresh mode', () => {
    const { onRefreshModeChange } = renderToolbar({ refreshMode: 'manual' })
    openSettings()
    const select = screen.getByDisplayValue('Manual only')
    fireEvent.change(select, { target: { value: 'ultra' } })
    expect(onRefreshModeChange).toHaveBeenCalledWith('ultra')
  })

  it('reports the tab size as a number, not the raw option string', () => {
    // Downstream CodeMirror config takes a number; '2' would be a silent
    // type error that only shows up as wrong indentation.
    const { onDefaultTabSizeChange } = renderToolbar({ defaultTabSize: 4 })
    openSettings()
    fireEvent.change(screen.getByDisplayValue('4'), { target: { value: '2' } })
    expect(onDefaultTabSizeChange).toHaveBeenCalledWith(2)
  })

  it('picks a browser and closes the menu', () => {
    // Choosing a browser is a one-shot action; leaving the menu open over the
    // diff after it just has to be dismissed again.
    const { onBrowserChange } = renderToolbar({ browser: '' })
    openSettings()
    fireEvent.change(screen.getByDisplayValue('Default'), { target: { value: 'firefox' } })
    expect(onBrowserChange).toHaveBeenCalledWith('firefox')
    expect(screen.queryByText('Live refresh')).toBeNull()
  })

  it('closes when the reviewer clicks outside it', () => {
    renderToolbar()
    openSettings()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('Live refresh')).toBeNull()
  })
})

describe('Toolbar — copying comments', () => {
  it('counts only the comments Copy will actually produce', () => {
    // formatAllComments excludes queued comments. Labelling the button with the total
    // would promise the reviewer text that never lands on the clipboard.
    renderToolbar({ commentCount: 5, queuedCount: 2 })
    expect(screen.getByRole('button', { name: 'Copy (3)' })).toBeEnabled()
  })

  it('disables Copy when every comment is still queued', () => {
    renderToolbar({ commentCount: 2, queuedCount: 2 })
    expect(screen.getByRole('button', { name: 'Copy (0)' })).toBeDisabled()
  })

  it('confirms the copy happened', async () => {
    const { onCopyComments } = renderToolbar({ commentCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Copy (1)' }))
    expect(onCopyComments).toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument()
  })
})

describe('Toolbar — queued comments', () => {
  it('offers "Post queued" only when queued comments exist', () => {
    renderToolbar({ commentCount: 1, queuedCount: 0 })
    expect(screen.queryByRole('button', { name: /Post queued/ })).toBeNull()
  })

  it('posts the queued comments', () => {
    const { onPostQueued } = renderToolbar({ commentCount: 3, queuedCount: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'Post queued (2)' }))
    expect(onPostQueued).toHaveBeenCalled()
  })
})

describe('Toolbar — finishing the review', () => {
  it('refuses to submit when nothing is listening', () => {
    // Submitting into the void ends the review with no one told; the label has
    // to say why rather than just looking broken.
    const { onSubmitReview } = renderToolbar({ commentCount: 2, watcherCount: 0, agentCount: 0 })
    const btn = screen.getByRole('button', { name: /No watcher/ })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(onSubmitReview).not.toHaveBeenCalled()
  })

  it('accepts an agent on the websocket as a listener, not just a CLI watcher', () => {
    // /api/events-ws is the streaming flow's transport now that v1 `watch` is
    // gone — treating only watcherCount as "listening" would disable Submit
    // for the primary path.
    const { onSubmitReview } = renderToolbar({ commentCount: 2, watcherCount: 0, agentCount: 1 })
    const btn = screen.getByRole('button', { name: /Done reviewing \(2\)/ })
    expect(btn).toBeEnabled()
    fireEvent.click(btn)
    fireEvent.click(screen.getByRole('button', { name: 'Finish review' }))
    expect(onSubmitReview).toHaveBeenCalled()
  })

  it('finishes a review with no comments at all', () => {
    // Sometimes the change is simply fine. Requiring a comment made the only
    // way to say so a fake one, and the count is dropped from the label rather
    // than shown as a reproachful (0).
    const { onSubmitReview } = renderToolbar({ commentCount: 0, watcherCount: 1 })
    const btn = screen.getByRole('button', { name: /Done reviewing$/ })
    expect(btn).toBeEnabled()
    fireEvent.click(btn)
    fireEvent.click(screen.getByRole('button', { name: 'Finish review' }))
    expect(onSubmitReview).toHaveBeenCalledWith('')
  })

  it('asks for concluding notes before submitting anything', () => {
    // The click opens the box; nothing is sent until Finish review. Submitting
    // on the first click would give the reviewer no chance to write them.
    const { onSubmitReview } = renderToolbar({ commentCount: 1, watcherCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: /Done reviewing/ }))
    expect(screen.getByRole('dialog', { name: 'Finish review' })).toBeInTheDocument()
    expect(onSubmitReview).not.toHaveBeenCalled()
  })

  it('passes the typed notes through', () => {
    const { onSubmitReview } = renderToolbar({ commentCount: 1, watcherCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: /Done reviewing/ }))
    fireEvent.change(screen.getByLabelText('Concluding notes'), {
      target: { value: 'Looks good.\n\nOne nit inline.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Finish review' }))
    expect(onSubmitReview).toHaveBeenCalledWith('Looks good.\n\nOne nit inline.')
  })

  it('finishes on Cmd-Enter from the notes box', () => {
    // The box takes focus on open, so a keyboard-only reviewer (and an agent
    // driving by keys) must be able to finish without finding a button.
    const { onSubmitReview } = renderToolbar({ commentCount: 1, watcherCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: /Done reviewing/ }))
    const box = screen.getByLabelText('Concluding notes')
    fireEvent.change(box, { target: { value: 'ship it' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(onSubmitReview).toHaveBeenCalledWith('ship it')
  })

  it('does not finish on a bare Enter — notes are multi-line', () => {
    const { onSubmitReview } = renderToolbar({ commentCount: 1, watcherCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: /Done reviewing/ }))
    fireEvent.keyDown(screen.getByLabelText('Concluding notes'), { key: 'Enter' })
    expect(onSubmitReview).not.toHaveBeenCalled()
  })

  it('closes without asking when the box is empty', () => {
    renderToolbar({ commentCount: 1, watcherCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: /Done reviewing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Finish review' })).toBeNull()
  })

  it('asks before discarding typed notes, on every way out', () => {
    // Cancel, Escape and a click outside all have to ask. Whichever one skips
    // the question is the one that loses the notes, and it will be the one the
    // reviewer happens to use.
    for (const exit of ['cancel', 'escape', 'outside'] as const) {
      renderToolbar({ commentCount: 1, watcherCount: 1 })
      fireEvent.click(screen.getByRole('button', { name: /Done reviewing/ }))
      const box = screen.getByLabelText('Concluding notes')
      fireEvent.change(box, { target: { value: 'worth keeping' } })
      if (exit === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      if (exit === 'escape') fireEvent.keyDown(box, { key: 'Escape' })
      if (exit === 'outside') fireEvent.mouseDown(document.body)
      expect(screen.getByRole('alert'), `exit: ${exit}`).toHaveTextContent('Discard your notes?')
      // Still there to go back to.
      expect(screen.getByLabelText('Concluding notes')).toHaveValue('worth keeping')
      cleanup()
    }
  })

  it('keeps the notes when the discard question is declined', () => {
    renderToolbar({ commentCount: 1, watcherCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: /Done reviewing/ }))
    fireEvent.change(screen.getByLabelText('Concluding notes'), { target: { value: 'keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('Concluding notes')).toHaveValue('keep me')
  })

  it('discards only when the question is answered', () => {
    const { onSubmitReview } = renderToolbar({ commentCount: 1, watcherCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: /Done reviewing/ }))
    fireEvent.change(screen.getByLabelText('Concluding notes'), { target: { value: 'bye' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('dialog', { name: 'Finish review' })).toBeNull()
    expect(onSubmitReview).not.toHaveBeenCalled()
  })

  it('locks out a second submit once the review is finished', () => {
    // Re-submitting would tell an already-detached session to stop again.
    const { onSubmitReview } = renderToolbar({
      commentCount: 2,
      watcherCount: 1,
      submittedAt: Date.now(),
    })
    const btn = screen.getByRole('button', { name: /Done ✓/ })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(onSubmitReview).not.toHaveBeenCalled()
  })

  it('warns in the tooltip that finishing also posts outstanding queued comments', () => {
    // Drafts are private until this click; the reviewer deserves to know the
    // button publishes them.
    renderToolbar({ commentCount: 3, queuedCount: 1, watcherCount: 1 })
    expect(
      screen.getByTitle('End the review session — also posts your 1 remaining queued comment.'),
    ).toBeInTheDocument()
  })

  it('shows the agent-connected indicator only when an agent is attached', () => {
    renderToolbar({ agentCount: 0 })
    expect(screen.queryByText('Agent connected')).toBeNull()
    cleanup()
    renderToolbar({ agentCount: 1 })
    expect(screen.getByText('Agent connected')).toBeInTheDocument()
  })
})

describe('Toolbar — repo summary', () => {
  it('pluralizes the changed-file count', () => {
    renderToolbar({ fileCount: 1 })
    expect(screen.getByText(/1 file changed/)).toBeInTheDocument()
    cleanup()
    renderToolbar({ fileCount: 2 })
    expect(screen.getByText(/2 files changed/)).toBeInTheDocument()
  })

  it('omits a zero add/delete count rather than printing +0', () => {
    const { container } = renderToolbar({ additions: 0, deletions: 5 })
    expect(container.querySelector('.stat-additions')).toBeNull()
    expect(container.querySelector('.stat-deletions')).toHaveTextContent('-5')
  })
})
