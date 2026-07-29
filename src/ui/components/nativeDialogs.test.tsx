import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CommentForm } from './CommentForm'
import { CommentBubble } from './CommentBubble'
import { CommentTracker } from './CommentTracker'
import { FileEditorModal } from './FileEditorModal'
import { SelectionPill } from './SelectionPill'
import { Toolbar } from './Toolbar'
import { NO_LANG, makeComment, typeInCodeMirror } from '../test-utils'

// krit exists to be driven programmatically: a Claude session opens the page,
// clicks through a review, and reads the result. window.confirm/alert block the
// whole page until a human dismisses them, so an agent that hits one deadlocks
// forever — and a failure path is exactly when nobody is watching the screen.
// CLAUDE.md states the rule; nothing enforced it until this file. Every
// decision and every failure has to be an inline strip instead.
//
// Making the stubs *throw* rather than return a value is deliberate: a test
// that merely asserted "confirm returned false" would still pass if the dialog
// were shown, which is the thing being banned.
function banNativeDialogs() {
  const boom = (kind: string) => () => {
    throw new Error(`${kind}() blocks the page — use an inline strip (see CLAUDE.md)`)
  }
  vi.stubGlobal('confirm', boom('confirm'))
  vi.stubGlobal('alert', boom('alert'))
  vi.stubGlobal('prompt', boom('prompt'))
}

beforeEach(banNativeDialogs)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('no native dialog on any decision path', () => {
  it('FileEditorModal: discarding unsaved edits', () => {
    const onClose = vi.fn()
    const { container } = render(
      <FileEditorModal
        filePath={NO_LANG}
        initialContents="original"
        onClose={onClose}
        onSave={async () => {}}
      />,
    )
    typeInCodeMirror(container, 'unsaved work')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // The question is asked in the page, so an agent can read and answer it.
    expect(screen.getByRole('alert')).toHaveTextContent(/Discard unsaved edits/)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('FileEditorModal: closing via the backdrop with unsaved edits', () => {
    const { container } = render(
      <FileEditorModal
        filePath={NO_LANG}
        initialContents="original"
        onClose={vi.fn()}
        onSave={async () => {}}
      />,
    )
    typeInCodeMirror(container, 'unsaved work')
    fireEvent.click(container.querySelector('.editor-modal-backdrop') as HTMLElement)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('FileEditorModal: closing via Escape with unsaved edits', () => {
    const { container } = render(
      <FileEditorModal
        filePath={NO_LANG}
        initialContents="original"
        onClose={vi.fn()}
        onSave={async () => {}}
      />,
    )
    typeInCodeMirror(container, 'unsaved work')
    fireEvent.keyDown(container.querySelector('.editor-modal') as HTMLElement, { key: 'Escape' })
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('FileEditorModal: a failed save reports inline, not through alert()', async () => {
    const { container } = render(
      <FileEditorModal
        filePath={NO_LANG}
        initialContents="original"
        onClose={vi.fn()}
        onSave={async () => {
          throw new Error('disk full')
        }}
      />,
    )
    typeInCodeMirror(container, 'unsaved work')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(screen.getByText('disk full')).toBeInTheDocument()
  })

  it('CommentBubble: deleting a comment', () => {
    // Deletion is irreversible, which is exactly the shape of thing a
    // developer reaches for confirm() to guard.
    const onDelete = vi.fn()
    render(<CommentBubble comment={makeComment()} onDelete={onDelete} onReply={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }))
    expect(onDelete).toHaveBeenCalledWith('c1')
  })

  it('CommentTracker: deleting a comment', () => {
    const onDelete = vi.fn()
    render(<CommentTracker comments={[makeComment()]} onDelete={onDelete} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }))
    expect(onDelete).toHaveBeenCalledWith('c1')
  })

  it('SelectionPill: deleting the selection out of the working-tree file', () => {
    // This one edits the user's file on disk — the strongest pull toward a
    // confirm() anywhere in this surface.
    const onDelete = vi.fn()
    render(<SelectionPill x={10} y={10} onComment={vi.fn()} onDelete={onDelete} />)
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }))
    expect(onDelete).toHaveBeenCalled()
  })

  it('CommentForm: cancelling a typed comment', () => {
    const onCancel = vi.fn()
    render(<CommentForm filePath={NO_LANG} onSubmit={vi.fn()} onCancel={onCancel} />)
    const field = screen.getByPlaceholderText('Leave a review comment...')
    fireEvent.change(field, { target: { value: 'work in progress' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('CommentForm: Escape in the body field with text typed', () => {
    const onCancel = vi.fn()
    render(<CommentForm filePath={NO_LANG} onSubmit={vi.fn()} onCancel={onCancel} />)
    const field = screen.getByPlaceholderText('Leave a review comment...')
    fireEvent.change(field, { target: { value: 'work in progress' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('CommentForm: leaving suggest mode with an edited rewrite', () => {
    const onSuggestModeChange = vi.fn()
    render(
      <CommentForm
        filePath={NO_LANG}
        originalLines="const a = 1"
        initialSuggestMode
        initialSuggestionText="const a = 2"
        onSuggestModeChange={onSuggestModeChange}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel suggest' }))
    expect(onSuggestModeChange).toHaveBeenLastCalledWith(false)
  })

  it('Toolbar: finishing the review, which also publishes private drafts', async () => {
    const onSubmitReview = vi.fn(async () => {})
    render(
      <Toolbar
        repoName="krit"
        branch="main"
        fileCount={1}
        additions={1}
        deletions={0}
        commentCount={3}
        diffStyle="split"
        diffOptions={{ staged: false, untracked: false, scope: 'uncommitted' }}
        defaultTabSize={4}
        customMode={false}
        watcherCount={1}
        agentCount={0}
        submittedAt={null}
        refreshMode="live-unless-active"
        staleCount={0}
        draftCount={2}
        onDiffStyleChange={vi.fn()}
        onDiffOptionsChange={vi.fn()}
        onDefaultTabSizeChange={vi.fn()}
        onBrowserChange={vi.fn()}
        onCopyComments={async () => {}}
        onSubmitReview={onSubmitReview}
        onRefreshModeChange={vi.fn()}
        onRefresh={vi.fn()}
        onPostDrafts={vi.fn()}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Done reviewing/ }))
    })
    expect(onSubmitReview).toHaveBeenCalled()
  })

  // Escape-to-back-out of a suggestion is the path an agent is most likely to
  // take, so a native confirm() here froze the page for exactly the caller
  // krit exists to serve. The prompt is an inline strip now: Escape asks,
  // "Discard" cancels the form, "Keep editing" returns to the rewrite.
  it('CommentForm: Escape in an edited suggest-mode rewrite asks inline', () => {
    const onCancel = vi.fn()
    const { container } = render(
      <CommentForm
        filePath={NO_LANG}
        originalLines="const a = 1"
        initialSuggestMode
        initialSuggestionText="const a = 2"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.keyDown(container.querySelector('.cm-content') as HTMLElement, { key: 'Escape' })
    // The first Escape must not discard on its own — that is the edit the
    // prompt exists to protect.
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('CommentForm: "Keep editing" returns to the rewrite instead of discarding', () => {
    const onCancel = vi.fn()
    const { container } = render(
      <CommentForm
        filePath={NO_LANG}
        originalLines="const a = 1"
        initialSuggestMode
        initialSuggestionText="const a = 2"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.keyDown(container.querySelector('.cm-content') as HTMLElement, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('CommentForm: a second Escape answers the strip', () => {
    // Escape that asks a question it then refuses to hear the answer to is the
    // same dead end as a native dialog for anyone driving by key events.
    const onCancel = vi.fn()
    const { container } = render(
      <CommentForm
        filePath={NO_LANG}
        originalLines="const a = 1"
        initialSuggestMode
        initialSuggestionText="const a = 2"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    )
    const cm = container.querySelector('.cm-content') as HTMLElement
    fireEvent.keyDown(cm, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.keyDown(cm, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('CommentForm: Escape from the description textarea asks too', () => {
    // The description sits directly below the rewrite in suggest mode, so it
    // is one Tab away — and its Escape used to discard the rewrite silently.
    const onCancel = vi.fn()
    render(
      <CommentForm
        filePath={NO_LANG}
        originalLines="const a = 1"
        initialSuggestMode
        initialSuggestionText="const a = 2"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.keyDown(screen.getByPlaceholderText(/optional/i), { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/Discard your suggested rewrite/)
  })

  it('CommentForm: the Cancel button asks before dropping a rewrite', () => {
    const onCancel = vi.fn()
    render(
      <CommentForm
        filePath={NO_LANG}
        originalLines="const a = 1"
        initialSuggestMode
        initialSuggestionText="const a = 2"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('CommentForm: the strip goes away when the rewrite is reverted', () => {
    // A prompt that outlives its condition asks about something that no longer
    // exists — and answering "Discard" would still throw away the body text.
    const onCancel = vi.fn()
    const { container } = render(
      <CommentForm
        filePath={NO_LANG}
        originalLines="const a = 1"
        initialSuggestMode
        initialSuggestionText="const a = 2"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.keyDown(container.querySelector('.cm-content') as HTMLElement, { key: 'Escape' })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    typeInCodeMirror(container, 'const a = 1')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('CommentForm: Escape with an untouched rewrite cancels without asking', () => {
    // Nothing to lose means nothing to ask about — a prompt on every Escape
    // would be its own kind of obstacle.
    const onCancel = vi.fn()
    const { container } = render(
      <CommentForm
        filePath={NO_LANG}
        originalLines="const a = 1"
        initialSuggestMode
        initialSuggestionText="const a = 1"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.keyDown(container.querySelector('.cm-content') as HTMLElement, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })
})

// The interaction tests above only cover paths a test actually walks. This
// reads the sources directly, so a dialog added on a branch nobody exercises
// still fails the build.
//
// It globs rather than listing files: a hand-maintained list silently stops
// covering the rule for every file written after it, which is exactly when a
// new confirm() would appear.
describe('no native dialog anywhere in the UI sources', () => {
  const CALL = /(?:\bwindow\s*\.\s*)?\b(confirm|alert|prompt)\s*\(/g
  // Vitest runs with the repo root as cwd (vite.config.ts's root).
  const uiRoot = join(process.cwd(), 'src', 'ui')

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') out.push(...sourceFiles(full))
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full)
      }
    }
    return out
  }

  const files = sourceFiles(uiRoot)

  it('finds the sources to scan at all', () => {
    // A glob that silently matched nothing would make every case below pass.
    expect(files.length).toBeGreaterThan(15)
  })

  for (const file of files) {
    it(`${relative(uiRoot, file)} calls no native dialog`, () => {
      const src = readFileSync(file, 'utf8')
      // Strip comments so prose about confirm() doesn't read as a call.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const hits = [...code.matchAll(CALL)].map((m) => m[0])
      expect(hits).toHaveLength(0)
    })
  }
})

