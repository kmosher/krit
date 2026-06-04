import { useState, useRef, useEffect, useMemo } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
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
  onCancel: () => void
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

export function CommentForm({ originalLines = '', filePath, onSubmit, onCancel }: CommentFormProps) {
  const [body, setBody] = useState('')
  const [suggestMode, setSuggestMode] = useState(false)
  const [suggestionText, setSuggestionText] = useState(originalLines)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const langExt = useLanguageExtension(filePath)
  const scheme = useColorScheme()

  useEffect(() => {
    bodyRef.current?.focus()
  }, [])

  useEffect(() => {
    if (suggestMode) {
      // Focus the CodeMirror editor as soon as it mounts so the user can start
      // typing the rewrite immediately.
      requestAnimationFrame(() => cmRef.current?.view?.focus())
    }
  }, [suggestMode])

  // Capture mutable refs to the latest submit/cancel handlers so the CodeMirror
  // keymap extension (created once) always calls through to the current closure
  // values instead of a stale snapshot.
  const submitRef = useRef<() => void>(() => {})
  const cancelRef = useRef<() => void>(onCancel)

  const handleSubmit = () => {
    const trimmedBody = body.trim()
    if (suggestMode) {
      // Only send a suggestion payload if the user actually edited the rewrite —
      // an unchanged suggestion is just noise that renders as a no-op diff.
      const changed = suggestionText !== originalLines
      if (!changed && !trimmedBody) return
      if (changed) {
        onSubmit(trimmedBody, { newLines: suggestionText.split('\n') })
      } else {
        onSubmit(trimmedBody)
      }
      return
    }
    if (trimmedBody) {
      onSubmit(trimmedBody)
    }
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
  // - Mod-Enter / Escape are wired at Prec.high so they win over CM's
  //   defaults (Escape would otherwise just clear focus).
  // - syntaxHighlighting(defaultHighlightStyle) is included explicitly because
  //   basicSetup's copy uses fallback:true, which can no-op when a language
  //   extension reconfigures in after mount.
  const cmExtensions = useMemo(
    () => [
      Prec.high(
        keymap.of([
          { key: 'Mod-Enter', run: () => { submitRef.current(); return true } },
          { key: 'Escape', run: () => { cancelRef.current(); return true } },
        ]),
      ),
      pierreSyntaxHighlighting(scheme),
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

  const suggestionField = suggestMode ? (
    <div className="comment-suggestion-cm">
      <CodeMirror
        ref={cmRef}
        value={suggestionText}
        onChange={(v) => setSuggestionText(v)}
        extensions={cmExtensions}
        theme={scheme}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          tabSize: 2,
        }}
      />
    </div>
  ) : null

  return (
    <div className="comment-form">
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
