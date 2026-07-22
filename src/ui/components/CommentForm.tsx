import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { pierreSyntaxHighlighting } from './pierreHighlightStyle'
import { useLanguageExtension } from '../hooks/useLanguageExtension'

interface CommentFormProps {
  // Original line content selected for the comment; required for suggest-mode
  // (we pre-fill the suggestion editor with it). Single-line: one string; range:
  // newline-joined. Empty string is treated as "no original content captured."
  originalLines?: string
  // Used in suggest mode to pick the syntax-highlighting language for the
  // CodeMirror editor. Optional so reply forms (which don't suggest) can omit it.
  filePath?: string
  onSubmit: (body: string, suggestion?: { newLines: string[] }) => void
  // "Save as draft" — posts the comment with status:'draft' instead of
  // 'open' (server-side; see server.ts POST /api/comments). Distinct from
  // the "draft" in this form's own lifted `pending`-map state below, which
  // is in-progress *typing*, not yet submitted at all. Omitted for reply
  // forms, which have no draft concept.
  onSaveDraft?: (body: string, suggestion?: { newLines: string[] }) => void
  onCancel: () => void
  // Lifted-state hooks for drafts that must survive a remount (see the
  // `pending` draft map in CodeViewWrapper). Omitted by callers that don't
  // need persistence — reply forms, which are short-lived and never remount
  // mid-typing — and the form falls back to plain local state seeded from
  // the `initial*` props.
  initialBody?: string
  initialSuggestMode?: boolean
  initialSuggestionText?: string
  onBodyChange?(body: string): void
  onSuggestModeChange?(suggestMode: boolean): void
  onSuggestionTextChange?(text: string): void
}

function useColorScheme(): 'light' | 'dark' {
  const [scheme, setScheme] = useState<'light' | 'dark'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
  )
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setScheme(e.matches ? 'dark' : 'light')
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  return scheme
}

export function CommentForm({
  originalLines = '',
  filePath,
  onSubmit,
  onSaveDraft,
  onCancel,
  initialBody,
  initialSuggestMode,
  initialSuggestionText,
  onBodyChange,
  onSuggestModeChange,
  onSuggestionTextChange,
}: CommentFormProps) {
  const [body, setBodyState] = useState(initialBody ?? '')
  const [suggestMode, setSuggestModeState] = useState(initialSuggestMode ?? false)
  const [suggestionText, setSuggestionTextState] = useState(initialSuggestionText ?? originalLines)
  // Wrap each setter so a lifted draft (CodeViewWrapper's `pending` map)
  // stays in sync on every keystroke without this component needing to know
  // whether it's backed by a draft or is a fire-and-forget reply form.
  const setBody = (v: string) => {
    setBodyState(v)
    onBodyChange?.(v)
  }
  const setSuggestMode = (v: boolean | ((prev: boolean) => boolean)) => {
    setSuggestModeState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v
      onSuggestModeChange?.(next)
      return next
    })
  }
  const setSuggestionText = (v: string) => {
    setSuggestionTextState(v)
    onSuggestionTextChange?.(v)
  }
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const formRef = useRef<HTMLDivElement>(null)
  const langExt = useLanguageExtension(filePath)
  const scheme = useColorScheme()

  // This form is portaled into CodeView's shadow root, and CodeMirror must be
  // told about that via its `root` option or it assumes `document`. With the
  // wrong root, WebKit breaks in two ways: root.activeElement retargets to the
  // shadow host so CM thinks it's never focused (and then skips writing cursor
  // moves back to the DOM — arrow keys appear dead), and selection reads come
  // back host-retargeted. CM's own Safari shadow-DOM workarounds
  // (getComposedRanges) only engage when view.root IS the shadow root.
  // Resolved from the mounted DOM pre-paint; the editor render is gated on it.
  const [cmRoot, setCmRoot] = useState<ShadowRoot | Document | null>(null)
  useLayoutEffect(() => {
    const rootNode = formRef.current?.getRootNode()
    setCmRoot(rootNode instanceof ShadowRoot ? rootNode : document)
  }, [])

  useEffect(() => {
    bodyRef.current?.focus()
  }, [])

  // Auto-grow the body textarea to fit its content (pasted text included) up
  // to the CSS max-height, past which it scrolls. height:auto first so it can
  // also shrink when text is deleted.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [body, suggestMode])

  useEffect(() => {
    if (suggestMode) {
      // Focus the CodeMirror editor as soon as it mounts so the user can start
      // typing the rewrite immediately. Kept as an rAF (rather than a plain
      // synchronous .focus()) even after the AnnotationEventGuard propagation
      // fix — the underlying reason is CM mounting its DOM one tick after this
      // effect runs (react-codemirror wires up the view in its own effect),
      // not the drag/focus-stealing bug that guard fixes.
      requestAnimationFrame(() => cmRef.current?.view?.focus())
    }
  }, [suggestMode])

  // Capture mutable refs to the latest submit/cancel handlers so the CodeMirror
  // keymap extension (created once) always calls through to the current closure
  // values instead of a stale snapshot.
  const submitRef = useRef<() => void>(() => {})
  const cancelRef = useRef<() => void>(onCancel)
  // Same staleness problem for the Escape handler's "is there a non-trivial
  // edit to lose" check.
  const suggestionDirtyRef = useRef(false)
  suggestionDirtyRef.current = suggestionText !== originalLines && suggestionText.trim() !== ''

  // Shared by both "Comment"/"Suggest rewrite" (dispatch=onSubmit) and "Save
  // as draft" (dispatch=onSaveDraft) — same validation and suggestion-payload
  // logic either way, just a different endpoint on the other end.
  const dispatch = (fn: (body: string, suggestion?: { newLines: string[] }) => void) => {
    const trimmedBody = body.trim()
    if (suggestMode) {
      // Only send a suggestion payload if the user actually edited the rewrite —
      // an unchanged suggestion is just noise that renders as a no-op diff.
      const changed = suggestionText !== originalLines
      if (!changed && !trimmedBody) return
      if (changed) {
        fn(trimmedBody, { newLines: suggestionText.split('\n') })
      } else {
        fn(trimmedBody)
      }
      return
    }
    if (trimmedBody) {
      fn(trimmedBody)
    }
  }
  const handleSubmit = () => dispatch(onSubmit)
  const handleSaveDraft = () => {
    if (onSaveDraft) dispatch(onSaveDraft)
  }
  submitRef.current = handleSubmit
  cancelRef.current = onCancel

  const handleTextareaKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      onCancel()
    }
  }

  // Memoized so the extensions array reference is stable across renders —
  // CodeMirror reconfigures on prop change, and a fresh array every render
  // both wastes work and can lose intermediate language loads.
  // - Mod-Enter is wired at Prec.high so it wins over CM's defaults.
  // - Escape is scoped: if CM itself has something to do with it (more than
  //   one selection range — the standard "Escape collapses multi-cursor"
  //   behavior), we return false and let CM's own keymap handle it first,
  //   rather than discarding the whole form on the very first Escape press.
  //   Only once CM has nothing left to do with Escape do we treat it as
  //   "cancel" — and if the rewrite has actually been edited, confirm before
  //   discarding it.
  // - syntaxHighlighting(defaultHighlightStyle) is included explicitly because
  //   basicSetup's copy uses fallback:true, which can no-op when a language
  //   extension reconfigures in after mount.
  const cmExtensions = useMemo(
    () => [
      Prec.high(
        keymap.of([
          { key: 'Mod-Enter', run: () => { submitRef.current(); return true } },
          {
            key: 'Escape',
            run: (view) => {
              if (view.state.selection.ranges.length > 1) return false
              if (suggestionDirtyRef.current && !window.confirm('Discard your suggested rewrite?')) {
                return true // handled — swallow the key, but don't cancel
              }
              cancelRef.current()
              return true
            },
          },
        ]),
      ),
      pierreSyntaxHighlighting(scheme),
      // Long lines wrap (matching the diff surface) instead of forcing a
      // horizontal scroll inside a little box.
      EditorView.lineWrapping,
      ...langExt,
    ],
    [langExt, scheme],
  )

  const submitLabel = suggestMode ? 'Suggest rewrite' : 'Comment'
  const submitDisabled = suggestMode
    ? suggestionText === originalLines && !body.trim()
    : !body.trim()

  const bodyField = (
    <textarea
      ref={bodyRef}
      className={suggestMode ? 'comment-form-description' : undefined}
      value={body}
      onChange={(e) => setBody(e.target.value)}
      onKeyDown={handleTextareaKeyDown}
      placeholder={suggestMode ? 'Optional description...' : 'Leave a review comment...'}
      rows={suggestMode ? 2 : 3}
    />
  )

  const suggestionField = suggestMode && cmRoot ? (
    <div className="comment-suggestion-cm">
      <CodeMirror
        ref={cmRef}
        value={suggestionText}
        onChange={(v) => setSuggestionText(v)}
        extensions={cmExtensions}
        theme={scheme}
        root={cmRoot}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          tabSize: 2,
          // drawSelection replaces the native caret with CM's own .cm-cursor
          // overlay, whose focus/selection tracking breaks inside CodeView's
          // shadow root on WebKit — the caret simply never renders. The
          // native caret works everywhere.
          drawSelection: false,
        }}
      />
    </div>
  ) : null

  return (
    <div className={`comment-form ${suggestMode ? 'comment-form-suggest' : ''}`} ref={formRef}>
      {/* In suggest mode the rewrite is the primary input — render it first
          and demote the body to a small "optional description" below. */}
      {suggestMode ? (
        <>
          {suggestionField}
          {bodyField}
        </>
      ) : (
        bodyField
      )}
      <div className="comment-form-actions">
        <button
          type="button"
          className={`btn btn-ghost ${suggestMode ? 'btn-ghost-active' : ''}`}
          onClick={() => setSuggestMode((m) => !m)}
          title="Toggle inline rewrite suggestion"
        >
          {suggestMode ? 'Cancel suggest' : 'Suggest edit'}
        </button>
        <div style={{ flex: 1 }} />
        {onSaveDraft && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleSaveDraft}
            disabled={submitDisabled}
            title="Save without posting — stays invisible to the listening Claude session until you post it (or click Done reviewing)."
          >
            Save as draft
          </button>
        )}
        <button className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={handleSubmit} disabled={submitDisabled}>
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
