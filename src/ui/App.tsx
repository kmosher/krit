import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { parsePatchFiles, parseDiffFromFile } from '@pierre/diffs'
import type { FileDiffMetadata, FileContents } from '@pierre/diffs'
import type { ReviewComment } from '../types'
import { useDiff, type BinaryFileInfo, type FileContentsMap } from './hooks/useDiff'
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

// Split a merged multi-file patch into one fragment per file, in patch
// order. Matches the section-boundary rule useDiff's spliceFilePatches /
// splitFilePatches use to splice/split fragments — a `diff --git a/... b/X`
// line starts a new section that runs until the next one. Cheap string scan
// (no diff parsing), so per-file re-parse below is the only place actual
// parsing work happens.
export function splitPatchFragments(patch: string): { name: string; text: string }[] {
  const lines = patch.split('\n')
  const targetPrefix = 'diff --git a/'
  const fragments: { name: string; text: string }[] = []
  let name: string | null = null
  let start = 0
  const flush = (end: number) => {
    if (name !== null) fragments.push({ name, text: lines.slice(start, end).join('\n') })
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(targetPrefix)) continue
    flush(i)
    const match = lines[i].match(/^diff --git a\/.+ b\/(.+)$/)
    name = match?.[1] ?? null
    start = i
  }
  flush(lines.length)
  return fragments
}

// +/- counts for one file's patch fragment. Split out of the old whole-patch
// walk (previously a second full pass over `patch`) so it folds into the
// same per-file pass as parseFileFragment below instead of re-walking the
// merged patch a second time.
export function computeFileStats(text: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

// A stub FileDiffMetadata for a path with no real hunks to show yet (a
// binary-only entry with no diff --git section of its own, or a fragment
// that failed to parse). Shape matches what parsePatchFiles would otherwise
// produce for an empty/patch-only file.
function stubFile(name: string, type: FileDiffMetadata['type']): FileDiffMetadata {
  return {
    name,
    type,
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  }
}

// Parse one file's patch fragment, upgrading it from patch-only
// (isPartial:true) to full-file (isPartial:false) by re-running it through
// parseDiffFromFile when both sides' contents are bundled in fileContents —
// full-file metadata is what CodeView needs to render the expand-context UI
// between hunks. Scoped to one file's fragment text (not the whole patch),
// so it only costs O(this file) rather than O(the whole review).
export function parseFileFragment(
  name: string,
  text: string,
  contentsEntry: FileContentsMap[string] | undefined,
): FileDiffMetadata {
  let parsedFile: FileDiffMetadata | undefined
  try {
    parsedFile = parsePatchFiles(text).flatMap((p) => p.files)[0]
  } catch {
    parsedFile = undefined
  }
  if (!parsedFile) return stubFile(name, 'change')
  // Use our own unquoted fragment name for display, not the parser's. For a
  // non-ASCII path @pierre/diffs re-emits `.name` in git's C-quoted octal form
  // ("src/caf\303\251.rs"), which then diverges from the unquoted key every
  // other map here uses (fileContents, the file cache, comment association),
  // and the FileTree splits the embedded quotes into a bogus folder node.
  parsedFile.name = name
  if (!contentsEntry || !('contents' in contentsEntry.old) || !('contents' in contentsEntry.new)) {
    // Oversize, binary, or missing on one side — patch-only it stays.
    return parsedFile
  }
  const oldFile: FileContents = { name: parsedFile.name, contents: contentsEntry.old.contents }
  const newFile: FileContents = { name: parsedFile.name, contents: contentsEntry.new.contents }
  try {
    const upgraded = parseDiffFromFile(oldFile, newFile)
    // Belt-and-suspenders: if old/new contents end up identical (e.g. a
    // ref/patch mismatch slipped through), the upgrade returns zero hunks
    // and CodeView would render headers with empty bodies. Fall back to the
    // patch-parsed file so something always shows.
    if (!upgraded.hunks || upgraded.hunks.length === 0) return parsedFile
    upgraded.name = name
    return upgraded
  } catch {
    return parsedFile
  }
}

// Per-file cache entry: the inputs a file's FileDiffMetadata was derived
// from (so the next render can tell, per file, whether it needs to be
// re-derived) plus the derived result itself. `fragmentText` is null for a
// binary-only synthetic entry (no diff --git section of its own); such
// entries are keyed on `binaryRef` (the BinaryFileInfo object identity)
// instead, which useDiff's splice logic keeps stable for every path that
// wasn't part of a given refetch (see loadFile/loadFiles).
interface FileCacheEntry {
  fragmentText: string | null
  contentsEntry: FileContentsMap[string] | undefined
  binaryRef: BinaryFileInfo | undefined
  file: FileDiffMetadata
  stats: { additions: number; deletions: number }
}

export function App() {
  const { settings, loaded, updateSettings } = useSettings()
  // Active file editor: path + the working-tree contents loaded for editing.
  // Loaded lazily on Edit click (small fetch) rather than carrying every
  // file's contents through React state.
  const [editingFile, setEditingFile] = useState<{ path: string; contents: string } | null>(null)
  // Files with an open draft (comment/suggest form) — merged with
  // editingFile below into the "active" set that gates 'live-unless-active'.
  const [activeDraftFiles, setActiveDraftFiles] = useState<Set<string>>(() => new Set())
  // Files in inline edit mode. Like an open draft, an open edit session makes
  // a file "active": under 'live-unless-active' a background write lands in
  // staleFiles and waits for an explicit apply instead of being pushed into
  // the document the user is typing in.
  const [inlineEditFiles, setInlineEditFiles] = useState<Set<string>>(() => new Set())
  const activeFiles = useMemo(() => {
    if (!editingFile && inlineEditFiles.size === 0) return activeDraftFiles
    const next = new Set(activeDraftFiles)
    for (const p of inlineEditFiles) next.add(p)
    if (editingFile) next.add(editingFile.path)
    return next
  }, [activeDraftFiles, editingFile, inlineEditFiles])

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
    dismissStale,
  } = useDiff({
    staged: settings.staged,
    untracked: settings.untracked,
    refreshMode: settings.refreshMode,
    activeFiles,
    editingFiles: inlineEditFiles,
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

  // Ending a session saves, and the save is a whole-file overwrite with no
  // base-version check server-side — so leaving edit mode with a queued change
  // outstanding would silently drop whatever wrote the file while you typed.
  // The queued change is the one thing the editor cannot merge for you, so ask
  // rather than pick: stay in edit mode (Apply, then decide) or overwrite.
  const handleToggleEdit = useCallback(
    (filePath: string) => {
      const leaving = inlineEditFiles.has(filePath)
      if (leaving && staleFiles.has(filePath)) {
        const overwrite = confirm(
          `${filePath} changed on disk while you were editing.\n\n` +
            `Saving now overwrites that change.\n\n` +
            `OK to save anyway, or Cancel to keep editing (use Apply to pull the change in first).`,
        )
        if (!overwrite) return
      }
      setInlineEditFiles((prev) => {
        const next = new Set(prev)
        if (!next.delete(filePath)) next.add(filePath)
        return next
      })
    },
    [inlineEditFiles, staleFiles],
  )

  // Inline edit session ended with changes. Pierre tears the editor down before
  // firing this (syncItemEditors cleans up the instance, then collects
  // completions), so the file-written refetch this write triggers cannot land
  // on a live document.
  const handleInlineEditComplete = useCallback(
    async (filePath: string, contents: string) => {
      try {
        const res = await fetch('/api/file-content', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, contents }),
        })
        if (!res.ok) {
          const msg = await res.text().catch(() => res.statusText)
          alert(`Save failed for ${filePath}: ${msg}`)
          return
        }
      } catch (err) {
        alert(`Save failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // Any queued change for this path is now moot — it was either folded in
      // via Apply or deliberately overwritten above, and the write's own
      // file-written refetch supersedes it either way. Without this the badge
      // would stay lit against a file that no longer differs from disk.
      dismissStale(filePath)
    },
    [dismissStale],
  )

  // Applying a queued change to a file with an open edit session goes through
  // the editor rather than the diff refetch: the write arrives as one undoable
  // edit, so the reader can read it in place and ⌘Z it away like their own
  // typing. Falls back to the refetch whenever there's no live editor to take
  // it — including the case where the session ended between event and click.
  // Paths whose apply is mid-flight. The Apply button stays lit until the
  // fetch resolves, so without this a second click (or the toolbar's
  // apply-everything) would issue a duplicate fetch and a second applyEdits
  // against a document that already absorbed the first.
  const applyingRef = useRef<Set<string>>(new Set())
  const handleApplyStale = useCallback(
    async (filePath: string) => {
      if (applyingRef.current.has(filePath)) return
      applyingRef.current.add(filePath)
      try {
        if (inlineEditFiles.has(filePath)) {
          const res = await fetch(
            `/api/file-content?path=${encodeURIComponent(filePath)}&version=new`,
          )
          if (res.ok && diffViewerRef.current?.applyExternalEdit(filePath, await res.text())) {
            dismissStale(filePath)
            return
          }
        }
        // No live editor to take it, or the read failed: the ordinary refetch
        // still shows the change, just without the undo entry.
        applyStaleFile(filePath)
      } catch {
        applyStaleFile(filePath)
      } finally {
        applyingRef.current.delete(filePath)
      }
    },
    [inlineEditFiles, applyStaleFile, dismissStale],
  )

  // The toolbar's refresh button, which means three different things: with
  // nothing queued it's a plain reload, and otherwise it drains the queue —
  // files being edited through their editors, the rest in one batched refetch.
  const handleRefreshAll = useCallback(() => {
    if (staleFiles.size === 0) {
      void reload()
      return
    }
    for (const p of staleFiles) {
      if (inlineEditFiles.has(p)) void handleApplyStale(p)
    }
    applyAllStale(inlineEditFiles)
  }, [staleFiles, inlineEditFiles, handleApplyStale, applyAllStale, reload])

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

  // Per-file cache keyed by path, persisted across renders. A file's cached
  // entry is reused (same FileDiffMetadata object, same stats) whenever its
  // patch fragment and bundled contents are unchanged from last render, so
  // only files whose fragment or fileContents[path] entry actually changed
  // get re-parsed — useDiff already replaces `fileContents` per-file (see
  // loadFile/loadFiles), so an unrelated file's refetch doesn't force a
  // whole-review re-parse here. Unchanged files keep stable object identity,
  // which CodeViewWrapper (see its per-file `lastFileRef` comparison) relies
  // on to skip its own patch-in-place work too.
  const fileCacheRef = useRef<Map<string, FileCacheEntry>>(new Map())

  // `files`, `diffStats`, and `fileStatsMap` all come out of one per-file
  // pass over `patch` — folding stats into the same walk that reparses a
  // file avoids a second full-patch scan (previously a separate memo here).
  const { files, diffStats, fileStatsMap } = useMemo(() => {
    const prevCache = fileCacheRef.current
    const nextCache = new Map<string, FileCacheEntry>()
    const orderedFiles: FileDiffMetadata[] = []
    const fileStatsMap: Record<string, { additions: number; deletions: number }> = {}
    let totalAdditions = 0
    let totalDeletions = 0

    if (patch) {
      for (const { name, text } of splitPatchFragments(patch)) {
        const contentsEntry = fileContents[name]
        const prev = prevCache.get(name)
        let file: FileDiffMetadata
        let stats: { additions: number; deletions: number }
        if (prev && prev.fragmentText === text && prev.contentsEntry === contentsEntry) {
          file = prev.file
          stats = prev.stats
        } else {
          file = parseFileFragment(name, text, contentsEntry)
          stats = computeFileStats(text)
        }
        nextCache.set(name, { fragmentText: text, contentsEntry, binaryRef: undefined, file, stats })
        orderedFiles.push(file)
        fileStatsMap[name] = stats
        totalAdditions += stats.additions
        totalDeletions += stats.deletions
      }

      // Add synthetic entries for binary files not already covered by a
      // patch fragment of their own.
      const existingNames = new Set(orderedFiles.map((f) => f.name))
      for (const bf of binaryFiles) {
        if (existingNames.has(bf.path)) continue
        const prev = prevCache.get(bf.path)
        const file =
          prev && prev.fragmentText === null && prev.binaryRef === bf
            ? prev.file
            : stubFile(bf.path, bf.type === 'added' || bf.type === 'untracked' ? 'new' : bf.type === 'deleted' ? 'deleted' : 'change')
        nextCache.set(bf.path, {
          fragmentText: null,
          contentsEntry: undefined,
          binaryRef: bf,
          file,
          stats: { additions: 0, deletions: 0 },
        })
        orderedFiles.push(file)
      }
    }

    fileCacheRef.current = nextCache
    return {
      files: orderedFiles,
      diffStats: { additions: totalAdditions, deletions: totalDeletions },
      fileStatsMap,
    }
  }, [patch, binaryFiles, fileContents])

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
        onRefresh={handleRefreshAll}
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
            onApplyStale={handleApplyStale}
            onFileClick={handleFileClick}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
          />
          {!sidebarCollapsed && (
            <CommentTracker
              comments={comments}
              onDelete={removeComment}
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
            editingFiles={inlineEditFiles}
            onToggleEdit={handleToggleEdit}
            onEditComplete={handleInlineEditComplete}
            staleFiles={staleFiles}
            onApplyStale={handleApplyStale}
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
