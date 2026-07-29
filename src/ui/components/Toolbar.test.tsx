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
    onSubmitReview: vi.fn(async () => {}),
    onRefreshModeChange: vi.fn(),
    onRefresh: vi.fn(),
    onPostDrafts: vi.fn(),
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
    draftCount: 0,
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
    // formatAllComments excludes drafts. Labelling the button with the total
    // would promise the reviewer text that never lands on the clipboard.
    renderToolbar({ commentCount: 5, draftCount: 2 })
    expect(screen.getByRole('button', { name: 'Copy (3)' })).toBeEnabled()
  })

  it('disables Copy when every comment is still a draft', () => {
    renderToolbar({ commentCount: 2, draftCount: 2 })
    expect(screen.getByRole('button', { name: 'Copy (0)' })).toBeDisabled()
  })

  it('confirms the copy happened', async () => {
    const { onCopyComments } = renderToolbar({ commentCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Copy (1)' }))
    expect(onCopyComments).toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument()
  })
})

describe('Toolbar — drafts', () => {
  it('offers "Post drafts" only when drafts exist', () => {
    renderToolbar({ commentCount: 1, draftCount: 0 })
    expect(screen.queryByRole('button', { name: /Post drafts/ })).toBeNull()
  })

  it('posts the drafts', () => {
    const { onPostDrafts } = renderToolbar({ commentCount: 3, draftCount: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'Post drafts (2)' }))
    expect(onPostDrafts).toHaveBeenCalled()
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
    expect(onSubmitReview).toHaveBeenCalled()
  })

  it('refuses to finish a review with no comments', () => {
    const { onSubmitReview } = renderToolbar({ commentCount: 0, watcherCount: 1 })
    const btn = screen.getByRole('button', { name: /Done reviewing \(0\)/ })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
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

  it('warns in the tooltip that finishing also posts outstanding drafts', () => {
    // Drafts are private until this click; the reviewer deserves to know the
    // button publishes them.
    renderToolbar({ commentCount: 3, draftCount: 1, watcherCount: 1 })
    expect(
      screen.getByTitle('End the review session — also posts your 1 remaining draft.'),
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
