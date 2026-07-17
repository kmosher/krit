import { useState, useRef, useEffect } from 'react'
import { GitBranch, Send, Settings, RefreshCw, Bot } from 'lucide-react'
import type { DiffOptions } from '../hooks/useDiff'
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
  onSubmitReview: () => Promise<void>
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

  const handleCopy = async () => {
    await onCopyComments()
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Copy excludes drafts (see formatAllComments) — label the count actually
  // copied, not the total including anything still draft-only.
  const postableCommentCount = commentCount - draftCount

  const hasWatcher = watcherCount > 0
  const isSubmitted = submittedAt !== null
  const submitDisabled = submitting || isSubmitted || !hasWatcher || commentCount === 0
  const submitLabel = isSubmitted
    ? 'Done ✓'
    : !hasWatcher
      ? 'No watcher'
      : `Done reviewing (${commentCount})`
  const submitTitle = isSubmitted
    ? 'Review finished — the listening Claude session has been told to stop watching.'
    : !hasWatcher
      ? 'No `diffx watch` (or `wait-for-submit`) is currently subscribed. Start one from Claude, or use Copy comments to paste manually.'
      : commentCount === 0
        ? 'Leave at least one comment before finishing the review.'
        : draftCount > 0
          ? `End the review session — also posts your ${draftCount} remaining draft${draftCount === 1 ? '' : 's'}.`
          : 'End the review session — tells the listening Claude session you are done.'

  const handleSubmit = async () => {
    if (submitDisabled) return
    setSubmitting(true)
    try {
      await onSubmitReview()
    } finally {
      setSubmitting(false)
    }
  }

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
                  <label className="settings-item">
                    <input
                      type="checkbox"
                      checked={diffOptions.staged}
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
              <div className="settings-item settings-item-spaced">
                <span>Live refresh</span>
                <select
                  className="settings-select"
                  value={refreshMode}
                  onChange={(e) => onRefreshModeChange(e.target.value as RefreshMode)}
                  title="How background file changes (fs-watcher) get applied. Your own edits and `diffx refresh` always apply immediately regardless of this setting."
                >
                  <option value="live-unless-active">Live (pause while editing)</option>
                  <option value="ultra">Always live</option>
                  <option value="manual">Manual only</option>
                </select>
              </div>
              <div className="settings-item settings-item-spaced">
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
              </div>
              <div className="settings-item settings-item-spaced">
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
              </div>
            </div>
          )}
        </div>
        {draftCount > 0 && (
          <button
            className="btn btn-sm btn-draft-post"
            onClick={onPostDrafts}
            title={`Post ${draftCount} draft comment${draftCount === 1 ? '' : 's'} — makes them visible to the listening Claude session.`}
          >
            Post drafts ({draftCount})
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
        <button
          className={`btn btn-primary btn-sm ${isSubmitted ? 'btn-active' : ''}`}
          onClick={handleSubmit}
          disabled={submitDisabled}
          title={submitTitle}
        >
          <Send size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
