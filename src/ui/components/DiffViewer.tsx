import { memo, useMemo, useRef, useEffect, forwardRef } from 'react'
import type { FileDiffMetadata, DiffLineAnnotation, AnnotationSide } from '@pierre/diffs'
import type { ReviewComment } from '../../types'
import type { BinaryFileInfo } from '../hooks/useDiff'
import type { SelectionAnchor } from '../utils/selectionMapping'
import type { PreviewFormat } from '../utils/previewFormat'
import { BinaryFileDiff } from './BinaryFileDiff'
import { CodeViewWrapper, type CodeViewWrapperHandle } from './CodeViewWrapper'

interface DiffViewerProps {
  files: FileDiffMetadata[]
  diffStyle: 'split' | 'unified'
  defaultTabSize: number
  viewedFiles: Set<string>
  binaryFiles: Map<string, BinaryFileInfo>
  commentCounts: Record<string, number>
  fileStatsMap: Record<string, { additions: number; deletions: number }>
  onViewedChange: (filePath: string, viewed: boolean) => void
  fileAnnotationsMap: Map<string, DiffLineAnnotation<ReviewComment>[]>
  onAddComment: (
    filePath: string,
    side: AnnotationSide,
    lineNumber: number,
    endLine: number,
    lineContent: string,
    body: string,
    suggestion?: { newLines: string[] },
    asQueued?: boolean,
    charAnchor?: { startColumn: number; endColumn: number; selectedText: string },
  ) => void
  onDeleteComment: (id: string) => void
  onReplyComment: (id: string, body: string) => void
  onEditComment: (id: string, body: string) => void
  onDeleteRange?: (filePath: string, anchor: SelectionAnchor) => void
  onActiveFileChange?: (filePath: string | null) => void
  onEditFile?: (filePath: string) => void
  onPreviewFile?: (filePath: string) => void
  previewableFiles: Set<string>
  previewFiles: Set<string>
  previewData: Map<string, { source: string; format: PreviewFormat; changedRanges: Array<[number, number]> }>
  editingFiles: Set<string>
  onToggleEdit: (filePath: string) => void
  onEditComplete: (filePath: string, contents: string) => void
  staleFiles: Set<string>
  onApplyStale: (filePath: string) => void
  confirmSaveFiles: Set<string>
  onCancelSaveConfirm: (filePath: string) => void
  onActiveDraftsChange?: (files: Set<string>) => void
}

export const DiffViewer = memo(
  forwardRef<CodeViewWrapperHandle, DiffViewerProps>(function DiffViewer(
    {
      files,
      diffStyle,
      defaultTabSize,
      viewedFiles,
      binaryFiles,
      commentCounts,
      fileStatsMap,
      onViewedChange,
      fileAnnotationsMap,
      onAddComment,
      onDeleteComment,
      onReplyComment,
      onEditComment,
      onDeleteRange,
      onActiveFileChange,
      onEditFile,
      onPreviewFile,
      previewableFiles,
      previewFiles,
      previewData,
      editingFiles,
      onToggleEdit,
      onEditComplete,
      staleFiles,
      onApplyStale,
      confirmSaveFiles,
      onCancelSaveConfirm,
      onActiveDraftsChange,
    },
    ref,
  ) {
    // Split binary files (rendered outside CodeView) from text files (rendered in CodeView).
    // CodeView expects FileDiffMetadata items; binaries are presentational image previews.
    const { textFiles, binaryFileEntries } = useMemo(() => {
      const text: FileDiffMetadata[] = []
      const bins: { file: FileDiffMetadata; info: BinaryFileInfo }[] = []
      for (const f of files) {
        const info = binaryFiles.get(f.name)
        if (info) bins.push({ file: f, info })
        else text.push(f)
      }
      // Stable directory-first sort, ported from the previous DiffViewer.
      const sort = (a: FileDiffMetadata, b: FileDiffMetadata) => {
        const partsA = a.name.split('/')
        const partsB = b.name.split('/')
        const len = Math.min(partsA.length, partsB.length)
        for (let i = 0; i < len; i++) {
          const aIsDir = i < partsA.length - 1
          const bIsDir = i < partsB.length - 1
          if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
          const cmp = partsA[i].localeCompare(partsB[i])
          if (cmp !== 0) return cmp
        }
        return partsA.length - partsB.length
      }
      text.sort(sort)
      bins.sort((x, y) => sort(x.file, y.file))
      return { textFiles: text, binaryFileEntries: bins }
    }, [files, binaryFiles])

    // The binary band can't live inside CodeView's scroller (the Virtualizer
    // takes root.firstElementChild as its content container), so fake it
    // scrolling away: pull the band up by the code scroller's scrollTop, like
    // a collapsing header. Scrolling back to the top brings it back.
    const binariesRef = useRef<HTMLDivElement>(null)
    const hasBinaries = binaryFileEntries.length > 0
    useEffect(() => {
      const band = binariesRef.current
      if (!band) return
      const surface = band.parentElement?.querySelector<HTMLElement>('.codeview-surface')
      if (!surface) return
      let raf = 0
      const apply = () => {
        raf = 0
        const y = Math.min(surface.scrollTop, band.offsetHeight)
        band.style.marginTop = `-${y}px`
      }
      const onScroll = () => {
        if (!raf) raf = requestAnimationFrame(apply)
      }
      surface.addEventListener('scroll', onScroll, { passive: true })
      apply()
      return () => {
        surface.removeEventListener('scroll', onScroll)
        if (raf) cancelAnimationFrame(raf)
      }
    }, [hasBinaries])

    if (textFiles.length === 0 && binaryFileEntries.length === 0) {
      return (
        <div className="empty-state">
          <p>No changes found.</p>
        </div>
      )
    }

    return (
      <div className="diff-viewer">
        {binaryFileEntries.length > 0 && (
          // Binary files render outside CodeView (it only knows text 'file'/'diff'
          // items), so they can't share its scroll. Bound them to their own
          // capped, scrollable band — otherwise a stack of tall image previews
          // fills the viewport and pins the code scroller below the fold, with
          // no way to scroll past until each is marked viewed.
          <div className="diff-viewer-binaries" ref={binariesRef}>
            {binaryFileEntries.map(({ file, info }) => (
              <BinaryFileDiff
                key={file.name}
                filePath={file.name}
                info={info}
                viewed={viewedFiles.has(file.name)}
                onViewedChange={onViewedChange}
              />
            ))}
          </div>
        )}
        {textFiles.length > 0 && (
          <CodeViewWrapper
            ref={ref}
            files={textFiles}
            diffStyle={diffStyle}
            defaultTabSize={defaultTabSize}
            viewedFiles={viewedFiles}
            fileAnnotationsMap={fileAnnotationsMap}
            commentCounts={commentCounts}
            fileStatsMap={fileStatsMap}
            onViewedChange={onViewedChange}
            onAddComment={onAddComment}
            onDeleteComment={onDeleteComment}
            onReplyComment={onReplyComment}
            onEditComment={onEditComment}
            onDeleteRange={onDeleteRange}
            onActiveFileChange={onActiveFileChange}
            onEditFile={onEditFile}
            onPreviewFile={onPreviewFile}
            previewableFiles={previewableFiles}
            previewFiles={previewFiles}
            previewData={previewData}
            editingFiles={editingFiles}
            onToggleEdit={onToggleEdit}
            onEditComplete={onEditComplete}
            staleFiles={staleFiles}
            onApplyStale={onApplyStale}
            confirmSaveFiles={confirmSaveFiles}
            onCancelSaveConfirm={onCancelSaveConfirm}
            onActiveDraftsChange={onActiveDraftsChange}
          />
        )}
      </div>
    )
  }),
)
