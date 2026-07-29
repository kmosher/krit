import { useState, useRef, useEffect } from 'react'
import { GitBranch, Send, Settings, RefreshCw, Bot } from 'lucide-react'
import type { DiffOptions, DiffScope } from '../hooks/useDiff'
import type { RefreshMode } from '../hooks/useSettings'

interface ToolbarProps {
  repoName: string
  branch: string
  fileCount: number
  additions: number
  deletions: number
  commentCount: number
  diffStyle: 'split' | 'unified'
  diffOptions: DiffOptions
  defaultTabSize: number
  browser?: string
  customMode: boolean
  onDiffStyleChange: (style: 'split' | 'unified') => void
  onDiffOptionsChange: (options: DiffOptions) => void
  onDefaultTabSizeChange: (size: number) => void
  onBrowserChange: (browser: string) => void
  onCopyComments: () => Promise<void>
  /** Number of CLI watchers subscribed to the event stream — gates Submit. */
  watcherCount: number
  /** Agent subscribers connected over the native /api/events-ws endpoint. */
  agentCount: number
  /** Timestamp the user clicked Submit on this page, or null. */
  submittedAt: number | null
  /** `summary` is the reviewer's concluding notes; '' when they wrote none. */
  onSubmitReview: (summary: string) => Promise<void>
  refreshMode: RefreshMode
  onRefreshModeChange: (mode: RefreshMode) => void
  /** Files with a background change deferred by refreshMode, waiting to be applied. */
  staleCount: number
  /** Manual escape hatch: applies any deferred files, or does a full reload if none. */
  onRefresh: () => void
  /** Draft comments (saved but not yet visible to any watcher/ws subscriber). */
  draftCount: number
  onPostDrafts: () => void
}

export function Toolbar({
  repoName,
  branch,
  fileCount,
  additions,
  deletions,
  commentCount,
  diffStyle,
  diffOptions,
  defaultTabSize,
  browser,
  customMode,
  onDiffStyleChange,
  onDiffOptionsChange,
  onDefaultTabSizeChange,
  onBrowserChange,
  onCopyComments,
  watcherCount,
  agentCount,
  submittedAt,
  onSubmitReview,
  refreshMode,
  onRefreshModeChange,
  staleCount,
  onRefresh,
  draftCount,
  onPostDrafts,
}: ToolbarProps) {
  const [copied, setCopied] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  // The concluding-notes box, and the discard question guarding an exit from
  // it once something has been typed.
  const [finishOpen, setFinishOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const finishRef = useRef<HTMLDivElement>(null)
  const summaryRef = useRef<HTMLTextAreaElement>(null)

  const handleCopy = async () => {
    await onCopyComments()
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Copy excludes drafts (see formatAllComments) — label the count actually
  // copied, not the total including anything still draft-only.
  const postableCommentCount = commentCount - draftCount

  // Either subscriber kind counts as "someone is listening": role:'cli'
  // (wait-for-submit over SSE) or role:'agent' (the /api/events-ws Monitor,
  // the streaming flow's transport now that v1 diffx's `watch` is retired).
  const hasWatcher = watcherCount > 0 || agentCount > 0
  const isSubmitted = submittedAt !== null
  // A review with no comments is a real verdict — sometimes the change is
  // simply fine — so an empty comment list no longer blocks finishing. The
  // concluding notes are where "looks good" gets said, which is also what
  // keeps a zero-comment submit from reaching the agent as pure silence.
  const submitDisabled = submitting || isSubmitted || !hasWatcher
  const submitLabel = isSubmitted
    ? 'Done ✓'
    : !hasWatcher
      ? 'No watcher'
      : commentCount === 0
        ? 'Done reviewing'
        : `Done reviewing (${commentCount})`
  const submitTitle = isSubmitted
    ? 'Review finished — the listening Claude session has been told to stop watching.'
    : !hasWatcher
      ? 'No agent or watcher is currently subscribed to events. Have Claude attach one, or use Copy comments to paste manually.'
      : draftCount > 0
        ? `End the review session — also posts your ${draftCount} remaining queued comment${draftCount === 1 ? '' : 's'}.`
        : commentCount === 0
          ? 'End the review session with no comments — add any concluding notes first.'
          : 'End the review session — tells the listening Claude session you are done.'

  // The button opens the notes box; the box's own button is what submits.
  const handleSubmitClick = () => {
    if (submitDisabled) return
    setFinishOpen(true)
  }

  const finish = async () => {
    if (submitting || isSubmitted) return
    setSubmitting(true)
    try {
      await onSubmitReview(summary)
      setFinishOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  // Every exit from the notes box runs through here, so no path drops typed
  // notes without asking — the rule CommentForm's requestCancel and
  // FileEditorModal's requestClose already follow.
  const requestCancel = () => {
    if (summary.trim() !== '') {
      setConfirmingDiscard(true)
      return
    }
    setFinishOpen(false)
  }

  const discard = () => {
    setConfirmingDiscard(false)
    setFinishOpen(false)
    setSummary('')
  }

  useEffect(() => {
    if (!finishOpen) {
      setConfirmingDiscard(false)
      return
    }
    // Focused on open so the notes can be typed and submitted without ever
    // reaching for the mouse.
    summaryRef.current?.focus()
  }, [finishOpen])

  useEffect(() => {
    if (!finishOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (finishRef.current && !finishRef.current.contains(e.target as Node)) requestCancel()
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
    // `summary` is a dependency because requestCancel reads it: a listener
    // bound while the box was empty would close it silently once it wasn't.
  }, [finishOpen, summary])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
    }
    if (settingsOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [settingsOpen])

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <h1 className="toolbar-title">{repoName}</h1>
        {branch && (
          <span className="toolbar-branch">
            <GitBranch size={12} />
            {branch}
          </span>
        )}
        <span className="toolbar-stat">
          {fileCount} file{fileCount !== 1 ? 's' : ''} changed
          {additions > 0 && <span className="stat-additions"> +{additions}</span>}
          {deletions > 0 && <span className="stat-deletions"> -{deletions}</span>}
        </span>
        {agentCount > 0 && (
          <span
            className="toolbar-agent-dot"
            title={`${agentCount} agent${agentCount === 1 ? '' : 's'} connected over /api/events-ws`}
          >
            <Bot size={12} />
            Agent connected
          </span>
        )}
      </div>
      <div className="toolbar-right">
        <div className="toolbar-toggle">
          <button
            className={`btn btn-sm ${diffStyle === 'split' ? 'btn-active' : ''}`}
            onClick={() => onDiffStyleChange('split')}
          >
            Split
          </button>
          <button
            className={`btn btn-sm ${diffStyle === 'unified' ? 'btn-active' : ''}`}
            onClick={() => onDiffStyleChange('unified')}
          >
            Unified
          </button>
        </div>
        <button
          className={`btn btn-sm ${staleCount > 0 ? 'btn-refresh-stale' : ''}`}
          onClick={onRefresh}
          title={
            staleCount > 0
              ? `${staleCount} file${staleCount === 1 ? '' : 's'} changed on disk — click to refresh`
              : 'Refresh the diff'
          }
        >
          <RefreshCw size={12} style={{ marginRight: staleCount > 0 ? 4 : 0, verticalAlign: -1 }} />
          {staleCount > 0 ? `${staleCount} changed` : null}
        </button>
        <div className="settings-wrapper" ref={settingsRef}>
          <button
            className={`btn btn-sm settings-btn ${settingsOpen ? 'btn-active' : ''}`}
            onClick={() => setSettingsOpen(!settingsOpen)}
            title="Settings"
          >
            <Settings size={14} />
          </button>
          {settingsOpen && (
            <div className="settings-menu">
              {!customMode && (
                <>
                  <label className="settings-item settings-item-spaced">
                    <span>Scope</span>
                    <select
                      className="settings-select"
                      value={diffOptions.scope}
                      onChange={(e) =>
                        onDiffOptionsChange({
                          ...diffOptions,
                          scope: e.target.value as DiffScope,
                        })
                      }
                    >
                      <option value="uncommitted">Uncommitted</option>
                      <option value="branch">Whole branch</option>
                    </select>
                  </label>
                  <label className="settings-item">
                    <input
                      type="checkbox"
                      checked={diffOptions.scope === 'branch' ? true : diffOptions.staged}
                      // A branch-scope diff spans the index whatever this says,
                      // so the control is disabled and shown checked rather
                      // than left live and ignored.
                      disabled={diffOptions.scope === 'branch'}
                      title={
                        diffOptions.scope === 'branch'
                          ? 'The whole-branch scope always includes staged changes'
                          : undefined
                      }
                      onChange={(e) =>
                        onDiffOptionsChange({ ...diffOptions, staged: e.target.checked })
                      }
                    />
                    Show staged
                  </label>
                  <label className="settings-item">
                    <input
                      type="checkbox"
                      checked={diffOptions.untracked}
                      onChange={(e) =>
                        onDiffOptionsChange({ ...diffOptions, untracked: e.target.checked })
                      }
                    />
                    Show untracked
                  </label>
                </>
              )}
              <label className="settings-item settings-item-spaced">
                <span>Live refresh</span>
                <select
                  className="settings-select"
                  value={refreshMode}
                  onChange={(e) => onRefreshModeChange(e.target.value as RefreshMode)}
                  title="How background file changes (fs-watcher) get applied. Your own edits and `krit refresh` always apply immediately regardless of this setting."
                >
                  <option value="live-unless-active">Live (pause while editing)</option>
                  <option value="ultra">Always live</option>
                  <option value="manual">Manual only</option>
                </select>
              </label>
              <label className="settings-item settings-item-spaced">
                <span>Default tab size</span>
                <select
                  className="settings-select"
                  value={defaultTabSize}
                  onChange={(e) => onDefaultTabSizeChange(Number(e.target.value))}
                >
                  <option value={2}>2</option>
                  <option value={4}>4</option>
                  <option value={8}>8</option>
                </select>
              </label>
              <label className="settings-item settings-item-spaced">
                <span>Browser</span>
                <select
                  className="settings-select"
                  value={browser || ''}
                  onChange={(e) => {
                    onBrowserChange(e.target.value)
                    setSettingsOpen(false)
                  }}
                >
                  <option value="">Default</option>
                  <option value="chrome">Chrome</option>
                  <option value="firefox">Firefox</option>
                  <option value="edge">Edge</option>
                  <option value="brave">Brave</option>
                </select>
              </label>
            </div>
          )}
        </div>
        {draftCount > 0 && (
          <button
            className="btn btn-sm btn-draft-post"
            onClick={onPostDrafts}
            title={`Post ${draftCount} queued comment${draftCount === 1 ? '' : 's'} — makes them visible to the listening Claude session.`}
          >
            Post queued ({draftCount})
          </button>
        )}
        <button
          className="btn btn-sm"
          onClick={handleCopy}
          disabled={postableCommentCount === 0}
          title="Copy comments as XML to paste into Claude. Drafts are excluded until posted."
        >
          {copied ? 'Copied!' : `Copy (${postableCommentCount})`}
        </button>
        <div className="finish-wrap" ref={finishRef}>
          <button
            className={`btn btn-primary btn-sm ${isSubmitted ? 'btn-active' : ''}`}
            onClick={handleSubmitClick}
            disabled={submitDisabled}
            title={submitTitle}
            aria-expanded={finishOpen}
          >
            <Send size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
            {submitLabel}
          </button>
          {finishOpen && (
            <div className="finish-panel" role="dialog" aria-label="Finish review">
              <label className="finish-label" htmlFor="finish-summary">
                Concluding notes
              </label>
              <textarea
                id="finish-summary"
                ref={summaryRef}
                className="finish-summary"
                value={summary}
                placeholder={
                  commentCount === 0
                    ? 'No comments — say what you concluded. Optional.'
                    : 'Anything to add alongside your comments? Optional.'
                }
                onChange={(e) => setSummary(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void finish()
                  }
                  // Escape backs out the same way Cancel does, question
                  // included — a keyboard-only exit must not be the one path
                  // that discards notes silently.
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    requestCancel()
                  }
                }}
              />
              {confirmingDiscard ? (
                <div className="finish-confirm" role="alert">
                  <span>Discard your notes?</span>
                  <button type="button" className="btn btn-danger" onClick={discard}>
                    Discard
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setConfirmingDiscard(false)}
                  >
                    Keep editing
                  </button>
                </div>
              ) : (
                <div className="finish-actions">
                  <span className="finish-hint">
                    {summary.trim() === '' ? 'Finishing without notes' : '⌘↵ to finish'}
                  </span>
                  <button type="button" className="btn btn-secondary" onClick={requestCancel}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void finish()}
                    disabled={submitting}
                  >
                    {submitting ? 'Finishing…' : 'Finish review'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
