import { act, fireEvent } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import type { ReviewComment } from '../types'

/**
 * A file extension no language pack matches, so `useLanguageExtension` settles
 * synchronously and nothing races a lazily-imported CodeMirror language. Any
 * test that renders a CodeMirror-backed component wants this rather than a
 * realistic path; a `.tsx` here makes the test flaky, not more faithful.
 */
export const NO_LANG = 'notes.zzz'

/**
 * A comment with every required field filled in. `createdAt` is a fixed number
 * rather than `Date.now()` because CommentTracker orders by it — a clock-based
 * default makes two comments built in the same millisecond order arbitrarily.
 *
 * Override whatever a test asserts on, even when the default already matches:
 * the assertion should name the value it depends on, so changing a default here
 * can't quietly invalidate a test elsewhere.
 */
export function makeComment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    filePath: `src/${NO_LANG}`,
    side: 'additions',
    lineNumber: 10,
    endLine: 10,
    lineContent: 'const a = 1',
    body: 'a note',
    status: 'open',
    createdAt: 1_000,
    replies: [],
    ...over,
  }
}

/**
 * Replace a CodeMirror document's contents.
 *
 * CodeMirror renders a contenteditable that fireEvent and userEvent cannot
 * drive — in the real editor a keystroke becomes a view dispatch, so this
 * dispatches directly. It throws rather than no-opping when there is no view,
 * because a silent no-op reads as "the component ignored the input", which is
 * exactly the bug these tests exist to catch.
 */
export function typeInCodeMirror(container: HTMLElement, text: string): void {
  const content = container.querySelector('.cm-content')
  if (!content) throw new Error('no CodeMirror rendered')
  const view = EditorView.findFromDOM(content as HTMLElement)
  if (!view) throw new Error('CodeMirror DOM present but no view attached')
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  })
}

/**
 * The submit chord inside a CodeMirror editor. CodeMirror binds "Mod-Enter",
 * which is Cmd on macOS and Ctrl elsewhere; both are fired so the result
 * doesn't depend on which host the suite runs on.
 */
export function modEnter(container: HTMLElement): void {
  const content = container.querySelector('.cm-content') as HTMLElement
  fireEvent.keyDown(content, { key: 'Enter', metaKey: true })
  fireEvent.keyDown(content, { key: 'Enter', ctrlKey: true })
}
