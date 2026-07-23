import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { parsePatchFiles, parseDiffFromFile } from '@pierre/diffs'
import type { FileDiffMetadata, FileContents } from '@pierre/diffs'
import type { ReviewComment } from '../types'
import { useDiff } from './hooks/useDiff'
import { useComments } from './hooks/useComments'
import { useReviewState, submitReview } from './hooks/useReviewState'
import { useSettings } from './hooks/useSettings'
import { useViewed } from './hooks/useViewed'
import { Toolbar } from './components/Toolbar'
import { DiffViewer } from './components/DiffViewer'
import type { CodeViewWrapperHandle } from './components/CodeViewWrapper'
import { FileTree } from './components/FileTree'
import { CommentTracker } from './components/CommentTracker'
import { FileEditorModal } from './components/FileEditorModal'
import { UndoToast } from './components/UndoToast'
import type { SelectionAnchor } from './utils/selectionMapping'

export function App() {
  const { settings, loaded, updateSettings } = useSettings()
  // Active file editor: path + the working-tree contents loaded for editing.
  // Loaded lazily on Edit click (small fetch) rather than carrying every
  // file's contents through React state.
  const [editingFile, setEditingFile] = useState<{ path: string; contents: string } | null>(null)
  // Files with an open draft (comment/suggest form) — merged with
  // editingFile below into the "active" set that gates 'live-unless-active'.
  const [activeDraftFiles, setActiveDraftFiles] = useState<Set<string>>(() => new Set())
  const activeFiles = useMemo(() => {
    if (!editingFile) return activeDraftFiles
    const next = new Set(activeDraftFiles)
    next.add(editingFile.path)
    return next
  }, [activeDraftFiles, editingFile])

  const {
    patch,
    repoName,
    branch,
    customMode,
    binaryFiles,
    fileContents,
    untrackedFiles,
    initialLoading,
    error,
    reload,
    staleFiles,
    applyStaleFile,
    applyAllStale,
  } = useDiff({
    staged: settings.staged,
    untracked: settings.untracked,
    refreshMode: settings.refreshMode,
    activeFiles,
  })
  const { comments, addComment, removeComment, replyToComment, copyAllComments, postDrafts, draftCount } =
    useComments()
  const reviewState = useReviewState()
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('krit-sidebar-collapsed') === 'true'
    } catch {
      return false
    }
  })
  const { viewedFiles, setViewed } = useViewed()
  const diffViewerRef = useRef<CodeViewWrapperHandle>(null)

  const handleEditFile = useCallback(async (filePath: string) => {
    // Pull current working-tree contents fresh — fileContents bundled in
    // /api/diff is whatever the diff thought 'new' was, which may diverge
    // from disk if the agent rewrote since the last poll.
    const res = await fetch(`/api/file-content?path=${encodeURIComponent(filePath)}&version=new`)
    if (!res.ok) {
      alert(`Could not load ${filePath}: HTTP ${res.status}`)
      return
    }
    const text = await res.text()
    setEditingFile({ path: filePath, contents: text })
  }, [])

  const handleSaveEditedFile = useCallback(async (contents: string) => {
    if (!editingFile) return
    const res = await fetch('/api/file-content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: editingFile.path, contents }),
    })
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText)
      throw new Error(`Save failed: ${msg}`)
    }
  }, [editingFile])

  // SelectionPill's "Delete" — splices the exact selected range out of the
  // working-tree file server-side and surfaces an Undo toast. Server owns
  // the actual undo buffer (POST /api/edits/undo by id); this is just the
  // toast's lifecycle.
  const [undoToast, setUndoToast] = useState<{ id: string; message: string } | null>(null)
  const handleDeleteRange = useCallback(async (filePath: string, anchor: SelectionAnchor) => {
    const res = await fetch('/api/edits/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath,
        startLine: anchor.startLine,
        startColumn: anchor.startColumn,
        endLine: anchor.endLine,
        endColumn: anchor.endColumn,
      }),
    })
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText)
      alert(`Delete failed: ${msg}`)
      return
    }
    const { undoId } = (await res.json()) as { undoId: string }
    const preview = anchor.selectedText.replace(/\s+/g, ' ').trim()
    setUndoToast({
      id: undoId,
      message: `Deleted "${preview.length > 40 ? preview.slice(0, 39) + '…' : preview}"`,
    })
  }, [])

  const handleUndoDelete = useCallback(async () => {
    if (!undoToast) return
    const { id } = undoToast
    setUndoToast(null)
    const res = await fetch('/api/edits/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText)
      alert(`Undo failed: ${msg}`)
    }
  }, [undoToast])

  useEffect(() => {
    try {
      localStorage.setItem('krit-sidebar-collapsed', String(sidebarCollapsed))
    } catch {}
  }, [sidebarCollapsed])

  const untrackedSet = useMemo(() => new Set(untrackedFiles), [untrackedFiles])

  const files = useMemo(() => {
    if (!patch) return []
    try {
      const parsed = parsePatchFiles(patch)
      const parsedFiles = parsed.flatMap((p) => p.files)

      // Upgrade each file's FileDiffMetadata from patch-only (isPartial:true)
      // to full-file (isPartial:false) by re-running it through
      // parseDiffFromFile when both sides' contents are bundled in the
      // /api/diff response. Full-file metadata is what CodeView needs to
      // render the expand-context UI between hunks.
      const upgraded = parsedFiles.map((file) => {
        const entry = fileContents[file.name]
        if (!entry) return file
        if (!('contents' in entry.old) || !('contents' in entry.new)) {
          // Oversize, binary, or missing on one side — patch-only it stays.
          return file
        }
        const oldFile: FileContents = { name: file.name, contents: entry.old.contents }
        const newFile: FileContents = { name: file.name, contents: entry.new.contents }
        try {
          const upgraded = parseDiffFromFile(oldFile, newFile)
          // Belt-and-suspenders: if old/new contents end up identical (e.g. a
          // ref/patch mismatch slipped through), the upgrade returns zero
          // hunks and CodeView would render headers with empty bodies. Fall
          // back to the patch-parsed file so something always shows.
          if (!upgraded.hunks || upgraded.hunks.length === 0) {
            return file
          }
          return upgraded
        } catch {
          return file
        }
      })

      // Add synthetic entries for binary files not already in parsed output
      const existingNames = new Set(upgraded.map((f) => f.name))
      for (const bf of binaryFiles) {
        if (!existingNames.has(bf.path)) {
          const syntheticFile: FileDiffMetadata = {
            name: bf.path,
            type: bf.type === 'added' || bf.type === 'untracked' ? 'new' : bf.type === 'deleted' ? 'deleted' : 'change',
            hunks: [],
            splitLineCount: 0,
            unifiedLineCount: 0,
            isPartial: true,
            deletionLines: [],
            additionLines: [],
          }
          upgraded.push(syntheticFile)
        }
      }

      return upgraded
    } catch {
      return []
    }
  }, [patch, binaryFiles, fileContents])

  // Per-file +/- counts derived from the patch text. We compute these here
  // (not from FileDiffMetadata.hunks) because parseDiffFromFile-upgraded files
  // produce hunks without +/- line counts. Walking the patch is O(n) once and
  // shared by Toolbar totals, FileTree rows, and CodeView header metadata.
  const { diffStats, fileStatsMap } = useMemo(() => {
    if (!patch) return { diffStats: { additions: 0, deletions: 0 }, fileStatsMap: {} as Record<string, { additions: number; deletions: number }> }
    const stats: Record<string, { additions: number; deletions: number }> = {}
    let totalAdd = 0
    let totalDel = 0
    let current: { additions: number; deletions: number } | null = null
    for (const line of patch.split('\n')) {
      if (line.startsWith('diff --git ')) {
        // "diff --git a/path b/path" — pull the new-side path
        const match = line.match(/ b\/(.+)$/)
        if (match) {
          current = { additions: 0, deletions: 0 }
          stats[match[1]] = current
        } else {
          current = null
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        if (current) current.additions++
        totalAdd++
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        if (current) current.deletions++
        totalDel++
      }
    }
    return { diffStats: { additions: totalAdd, deletions: totalDel }, fileStatsMap: stats }
  }, [patch])

  const binaryFileMap = useMemo(() => {
    const map = new Map<string, (typeof binaryFiles)[number]>()
    for (const bf of binaryFiles) {
      map.set(bf.path, bf)
    }
    return map
  }, [binaryFiles])

  const commentCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const c of comments) {
      counts[c.filePath] = (counts[c.filePath] ?? 0) + 1
    }
    return counts
  }, [comments])

  const fileAnnotationsMap = useMemo(() => {
    const map = new Map<string, { side: ReviewComment['side']; lineNumber: number; metadata: ReviewComment }[]>()
    for (const c of comments) {
      let list = map.get(c.filePath)
      if (!list) {
        list = []
        map.set(c.filePath, list)
      }
      list.push({
        side: c.side,
        lineNumber: c.lineNumber,
        metadata: c,
      })
    }
    return map
  }, [comments])

  const handleFileClick = useCallback((filePath: string) => {
    setActiveFile(filePath)
    diffViewerRef.current?.scrollToFile(filePath)
  }, [])

  const handleViewedChange = useCallback((filePath: string, viewed: boolean) => {
    setViewed(filePath, viewed)
  }, [setViewed])

  if (!loaded || initialLoading) {
    return (
      <div className="loading">
        <p>Loading diff...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="error">
        <p>Error: {error}</p>
      </div>
    )
  }

  return (
    <div className="app">
      <Toolbar
        repoName={repoName}
        branch={branch}
        fileCount={files.length}
        additions={diffStats.additions}
        deletions={diffStats.deletions}
        commentCount={comments.length}
        diffStyle={settings.diffStyle}
        diffOptions={{ staged: settings.staged, untracked: settings.untracked }}
        defaultTabSize={settings.defaultTabSize}
        browser={settings.browser}
        customMode={customMode}
        onDiffStyleChange={(style) => updateSettings({ diffStyle: style })}
        onDiffOptionsChange={(options) => updateSettings(options)}
        onDefaultTabSizeChange={(size) => updateSettings({ defaultTabSize: size })}
        onBrowserChange={(browser) => updateSettings({ browser })}
        onCopyComments={copyAllComments}
        watcherCount={reviewState.watcherCount}
        agentCount={reviewState.agentCount}
        submittedAt={reviewState.submittedAt}
        onSubmitReview={submitReview}
        refreshMode={settings.refreshMode}
        onRefreshModeChange={(refreshMode) => updateSettings({ refreshMode })}
        staleCount={staleFiles.size}
        onRefresh={() => (staleFiles.size > 0 ? applyAllStale() : reload())}
        draftCount={draftCount}
        onPostDrafts={postDrafts}
      />
      <div className="app-body">
        <aside className={`sidebar ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          <FileTree
            files={files}
            activeFile={activeFile}
            commentCounts={commentCounts}
            fileStatsMap={fileStatsMap}
            viewedFiles={viewedFiles}
            untrackedFiles={untrackedSet}
            staleFiles={staleFiles}
            onApplyStale={applyStaleFile}
            onFileClick={handleFileClick}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
          />
          {!sidebarCollapsed && (
            <CommentTracker
              comments={comments}
              onJump={(comment) => {
                setActiveFile(comment.filePath)
                diffViewerRef.current?.scrollToLine(
                  comment.filePath,
                  comment.side,
                  comment.lineNumber,
                )
              }}
            />
          )}
        </aside>
        <main className="main">
          <DiffViewer
            // Remount the whole CodeView surface when the diff identity changes
            // (staged/untracked toggle, custom-mode arg change). Cleanly drops
            // viewer state — scroll position, virtualization layout, draft
            // comment — instead of trying to patch them across the transition.
            key={`${settings.staged}:${settings.untracked}:${customMode}`}
            ref={diffViewerRef}
            files={files}
            diffStyle={settings.diffStyle}
            defaultTabSize={settings.defaultTabSize}
            viewedFiles={viewedFiles}
            binaryFiles={binaryFileMap}
            commentCounts={commentCounts}
            fileStatsMap={fileStatsMap}
            onViewedChange={handleViewedChange}
            fileAnnotationsMap={fileAnnotationsMap}
            onAddComment={addComment}
            onDeleteComment={removeComment}
            onReplyComment={replyToComment}
            onDeleteRange={handleDeleteRange}
            onActiveFileChange={setActiveFile}
            onEditFile={handleEditFile}
            onActiveDraftsChange={setActiveDraftFiles}
          />
        </main>
      </div>
      {editingFile && (
        <FileEditorModal
          filePath={editingFile.path}
          initialContents={editingFile.contents}
          onClose={() => setEditingFile(null)}
          onSave={handleSaveEditedFile}
        />
      )}
      {undoToast && (
        <UndoToast
          message={undoToast.message}
          onUndo={handleUndoDelete}
          onDismiss={() => setUndoToast(null)}
        />
      )}
    </div>
  )
}
