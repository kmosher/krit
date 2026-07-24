import { useState, useMemo, useRef, useCallback, useLayoutEffect, memo } from 'react'
import type { UIEvent } from 'react'
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FilePlus,
  FileMinus,
  FileDiff,
  FileEdit,
  FileCheck,
  FileQuestion,
  MessageSquare,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import type { FileDiffMetadata } from '@pierre/diffs'

interface FileTreeProps {
  files: FileDiffMetadata[]
  activeFile: string | null
  commentCounts: Record<string, number>
  fileStatsMap: Record<string, { additions: number; deletions: number }>
  viewedFiles: Set<string>
  untrackedFiles: Set<string>
  // Files with a change deferred by refreshMode ('manual', or
  // 'live-unless-active' while the file is active) — rendered as a small dot
  // so the reviewer knows a background edit is waiting to be applied.
  staleFiles?: Set<string>
  // Clicking the stale dot applies just that file's deferred change,
  // instead of the toolbar's refresh-everything escape hatch.
  onApplyStale?: (filePath: string) => void
  onFileClick: (filePath: string) => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}

const EMPTY_STALE: Set<string> = new Set()

interface TreeNode {
  name: string
  path: string
  isDir: boolean
  children: TreeNode[]
  file?: FileDiffMetadata
}

function buildTree(files: FileDiffMetadata[]): TreeNode[] {
  const root: TreeNode[] = []

  for (const file of files) {
    const parts = file.name.split('/')
    let current = root

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const path = parts.slice(0, i + 1).join('/')
      const isDir = i < parts.length - 1

      let existing = current.find((n) => n.name === name && n.isDir === isDir)
      if (!existing) {
        existing = { name, path, isDir, children: [] }
        if (!isDir) existing.file = file
        current.push(existing)
      }
      current = existing.children
    }
  }

  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.isDir) sortNodes(node.children)
    }
  }
  sortNodes(root)

  return root
}

// Flattened row list — the tree is walked once per (tree, collapsedDirs)
// change into the exact sequence of rows that would be visible if nothing
// were windowed. Virtualization then slices this array instead of the
// component tree, so directory expand/collapse state has to live here
// (lifted out of TreeDir) rather than as local state per node.
type FlatRow =
  | { type: 'dir'; node: TreeNode; depth: number }
  | { type: 'file'; node: TreeNode; depth: number }

function flattenTree(nodes: TreeNode[], depth: number, collapsedDirs: Set<string>, out: FlatRow[]) {
  for (const node of nodes) {
    if (node.isDir) {
      out.push({ type: 'dir', node, depth })
      if (!collapsedDirs.has(node.path)) {
        flattenTree(node.children, depth + 1, collapsedDirs, out)
      }
    } else {
      out.push({ type: 'file', node, depth })
    }
  }
}

function inferChangeType(file: FileDiffMetadata, untrackedFiles: Set<string>): string {
  if (untrackedFiles.has(file.name)) return 'untracked'
  // parsePatchFiles doesn't always set changeType, infer from object IDs
  if (file.prevName) return 'rename-changed'
  const prev = file.prevObjectId
  const next = file.newObjectId
  if (prev === '0000000' || prev === '0000000000000000000000000000000000000000') return 'new'
  if (next === '0000000' || next === '0000000000000000000000000000000000000000') return 'deleted'
  return 'change'
}

function getFileIcon(file: FileDiffMetadata | undefined, viewed: boolean, untrackedFiles: Set<string>) {
  const size = 16
  if (viewed) {
    return <FileCheck size={size} className="ft-icon icon-viewed" />
  }
  const changeType = file ? inferChangeType(file, untrackedFiles) : 'change'
  switch (changeType) {
    case 'new':
      return <FilePlus size={size} className="ft-icon icon-added" />
    case 'untracked':
      return <FileQuestion size={size} className="ft-icon icon-untracked" />
    case 'deleted':
      return <FileMinus size={size} className="ft-icon icon-deleted" />
    case 'rename-pure':
    case 'rename-changed':
      return <FileEdit size={size} className="ft-icon icon-renamed" />
    default:
      return <FileDiff size={size} className="ft-icon icon-modified" />
  }
}

// Fixed row height — matches `.ft-row`'s `min-height: 32px` (global.css),
// which always wins over content height for this row's font-size/padding.
// Windowing needs a constant to convert scrollTop into an index range
// without measuring every row.
const ROW_HEIGHT = 32
const OVERSCAN = 12

const TreeDirRow = memo(function TreeDirRow({
  node,
  depth,
  expanded,
  top,
  onToggle,
}: {
  node: TreeNode
  depth: number
  expanded: boolean
  top: number
  onToggle: (path: string) => void
}) {
  return (
    <li style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_HEIGHT }}>
      <div
        className="ft-row ft-dir"
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => onToggle(node.path)}
      >
        <ChevronRight
          size={14}
          className={`ft-chevron ${expanded ? 'ft-chevron-expanded' : ''}`}
        />
        {expanded ? (
          <FolderOpen size={16} className="ft-icon ft-folder-icon" />
        ) : (
          <Folder size={16} className="ft-icon ft-folder-icon" />
        )}
        <span className="ft-dir-name">{node.name}</span>
      </div>
    </li>
  )
})

const TreeFileRow = memo(function TreeFileRow({
  node,
  activeFile,
  commentCount,
  stats,
  viewed,
  untrackedFiles,
  stale,
  onApplyStale,
  onFileClick,
  depth,
  top,
}: {
  node: TreeNode
  activeFile: string | null
  commentCount: number
  stats: { additions: number; deletions: number } | undefined
  viewed: boolean
  untrackedFiles: Set<string>
  stale: boolean
  onApplyStale?: (filePath: string) => void
  onFileClick: (filePath: string) => void
  depth: number
  top: number
}) {
  const filePath = node.file?.name ?? node.path
  const isActive = activeFile === filePath

  return (
    <li style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_HEIGHT }}>
      <div
        className={`ft-row ft-file ${isActive ? 'ft-file-active' : ''} ${viewed ? 'ft-file-viewed' : ''}`}
        style={{ paddingLeft: `${12 + depth * 16 + 20}px` }}
        onClick={() => onFileClick(filePath)}
        title={stale ? `${filePath} — changed on disk, click the dot to refresh just this file` : filePath}
      >
        {getFileIcon(node.file, viewed, untrackedFiles)}
        <span className="ft-file-name">{node.name}</span>
        {stale && (
          <span
            className="ft-stale-dot"
            role="button"
            title="Changed on disk — click to refresh"
            onClick={(e) => {
              e.stopPropagation()
              onApplyStale?.(filePath)
            }}
          />
        )}
        {stats && (stats.additions > 0 || stats.deletions > 0) && (
          <span className="ft-stats">
            {stats.additions > 0 && <span className="ft-stat-add">+{stats.additions}</span>}
            {stats.deletions > 0 && <span className="ft-stat-del">−{stats.deletions}</span>}
          </span>
        )}
        {commentCount > 0 && (
          <span className="ft-comment-count">
            <MessageSquare size={14} />
            {commentCount}
          </span>
        )}
      </div>
    </li>
  )
})

function FileTreeImpl({
  files,
  activeFile,
  commentCounts,
  fileStatsMap,
  viewedFiles,
  untrackedFiles,
  staleFiles = EMPTY_STALE,
  onApplyStale,
  onFileClick,
  collapsed,
  onToggleCollapse,
}: FileTreeProps) {
  const [filter, setFilter] = useState('')
  // Directory expand/collapse used to be local state on each TreeDir
  // instance; lifted here (keyed by path) so the row list can be flattened
  // and virtualized instead of walked as a live component tree. Absent from
  // the set == expanded, matching the old `defaultExpanded={true}` default.
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set())

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  const filteredFiles = useMemo(() => {
    if (!filter) return files
    const lower = filter.toLowerCase()
    return files.filter((f) => f.name.toLowerCase().includes(lower))
  }, [files, filter])

  const tree = useMemo(() => buildTree(filteredFiles), [filteredFiles])

  const flatRows = useMemo(() => {
    const out: FlatRow[] = []
    flattenTree(tree, 0, collapsedDirs, out)
    return out
  }, [tree, collapsedDirs])

  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  // Track the scroller's viewport height so the visible-row window can be
  // computed. Re-measures on resize (e.g. window resize, sidebar toggle).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [collapsed])

  const total = flatRows.length
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const endIndex = Math.min(total, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
  const visibleRows = flatRows.slice(startIndex, endIndex)

  if (collapsed) {
    return (
      <div className="ft">
        <div className="ft-search">
          {onToggleCollapse && (
            <button
              className="sidebar-toggle"
              onClick={onToggleCollapse}
              title="Expand sidebar"
              aria-label="Expand sidebar"
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="ft-search">
        {onToggleCollapse && (
          <button
            className="sidebar-toggle"
            onClick={onToggleCollapse}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose size={16} />
          </button>
        )}
        <div className="ft-search-wrapper">
          <Search size={14} className="ft-search-icon" />
          <input
            type="text"
            placeholder="Filter files..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="ft-search-input"
          />
        </div>
      </div>
      <div className="ft" ref={scrollRef} onScroll={handleScroll}>
        <ul className="ft-list ft-root" style={{ position: 'relative', height: total * ROW_HEIGHT }}>
          {visibleRows.map((row, i) => {
            const top = (startIndex + i) * ROW_HEIGHT
            if (row.type === 'dir') {
              return (
                <TreeDirRow
                  key={row.node.path}
                  node={row.node}
                  depth={row.depth}
                  expanded={!collapsedDirs.has(row.node.path)}
                  top={top}
                  onToggle={toggleDir}
                />
              )
            }
            const filePath = row.node.file?.name ?? row.node.path
            return (
              <TreeFileRow
                key={row.node.path}
                node={row.node}
                activeFile={activeFile}
                commentCount={commentCounts[filePath] ?? 0}
                stats={fileStatsMap[filePath]}
                viewed={viewedFiles.has(filePath)}
                untrackedFiles={untrackedFiles}
                stale={staleFiles.has(filePath)}
                onApplyStale={onApplyStale}
                onFileClick={onFileClick}
                depth={row.depth}
                top={top}
              />
            )
          })}
        </ul>
      </div>
    </>
  )
}

export const FileTree = memo(FileTreeImpl)
