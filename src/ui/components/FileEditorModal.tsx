import { useState, useEffect, useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { useLanguageExtension } from '../hooks/useLanguageExtension'
import { pierreSyntaxHighlighting } from './pierreHighlightStyle'

interface Props {
  filePath: string
  initialContents: string
  onClose: () => void
  // Resolved when the server confirms the write. The caller should rely on the
  // SSE 'file-written' broadcast (via useDiff) to refresh the diff view;
  // returning a fulfilled promise here only signals success/failure for the
  // editor's local state.
  onSave: (contents: string) => Promise<void>
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

export function FileEditorModal({ filePath, initialContents, onClose, onSave }: Props) {
  const [contents, setContents] = useState(initialContents)
  // `initialContents` is both the seed and the baseline `dirty` measures
  // against, so it has to be re-read if the parent loads the file again while
  // the modal is open — otherwise the editor shows someone else's text and
  // calls it the reader's unsaved work. A fresh load is a fresh session, so
  // reseed the document with it too.
  const [baseline, setBaseline] = useState(initialContents)
  if (baseline !== initialContents) {
    setBaseline(initialContents)
    setContents(initialContents)
  }
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Closing with unsaved edits asks first, as an inline strip rather than a
  // native confirm(): a modal dialog freezes the whole page for anything
  // driving the browser programmatically, and krit exists to be driven by an
  // agent. Same reason the inline editor's save-over-a-stale-file prompt is
  // rendered rather than confirm()ed.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const langExt = useLanguageExtension(filePath)
  const scheme = useColorScheme()
  const cmExtensions = useMemo(() => [pierreSyntaxHighlighting(scheme), ...langExt], [langExt, scheme])

  const dirty = contents !== baseline

  const handleSave = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setErr(null)
    try {
      await onSave(contents)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  // Every exit — Cancel, Escape, backdrop click — goes through here so none of
  // them can drop unsaved edits without asking. The backdrop used to close
  // outright, which made it the one silent discard path.
  const requestClose = () => {
    if (saving) return
    if (dirty) {
      setConfirmingDiscard(true)
      return
    }
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      requestClose()
    }
    // `key` OR `code`, because neither alone reaches every keyboard. `key` is
    // the character the layout produced, so it is what a Dvorak or Colemak user
    // means by "S" — but on a layout with no Latin `s` at all (Cyrillic, Greek,
    // or an active CJK input method) it never arrives, and the only save
    // shortcut in krit would be unreachable. `code` names the physical key,
    // which those layouts still report as KeyS. Accepting both costs nothing:
    // no layout produces `s` from a key that isn't KeyS *and* means something
    // else by it.
    if ((e.key === 's' || e.code === 'KeyS') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handleSave()
    }
  }

  return (
    <div className="editor-modal-backdrop" onClick={requestClose}>
      <div className="editor-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="editor-modal-header">
          <span className="editor-modal-path">{filePath}</span>
          {dirty && <span className="editor-modal-dirty">• unsaved</span>}
          <div style={{ flex: 1 }} />
          <button className="btn btn-secondary" onClick={requestClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!dirty || saving}
            title="Save (⌘S)"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {confirmingDiscard && (
          <div className="editor-modal-confirm" role="alert">
            <span>Discard unsaved edits to {filePath}?</span>
            <button className="btn btn-danger" onClick={onClose}>
              Discard
            </button>
            <button className="btn btn-secondary" onClick={() => setConfirmingDiscard(false)}>
              Keep editing
            </button>
          </div>
        )}
        {err && <div className="editor-modal-error">{err}</div>}
        <div className="editor-modal-cm">
          <CodeMirror
            value={contents}
            onChange={(v) => setContents(v)}
            extensions={cmExtensions}
            theme={scheme}
            height="100%"
            autoFocus
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              foldGutter: true,
              tabSize: 4,
            }}
          />
        </div>
      </div>
    </div>
  )
}
