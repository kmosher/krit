import { memo, useMemo, forwardRef } from 'react'
import type { FileDiffMetadata, DiffLineAnnotation, AnnotationSide } from '@pierre/diffs'
import type { ReviewComment } from '../../types'
import type { BinaryFileInfo } from '../hooks/useDiff'
import { BinaryFileDiff } from './BinaryFileDiff'
import { CodeViewWrapper, type CodeViewWrapperHandle } from './CodeViewWrapper'

interface DiffViewerProps {
  files: FileDiffMetadata[]
  diffStyle: 'split' | 'unified'
  defaultTabSize: number
  viewedFiles: Set<string>
  binaryFiles: Map<string, BinaryFileInfo>
  onViewedChange: (filePath: string, viewed: boolean) => void
  fileAnnotationsMap: Map<string, DiffLineAnnotation<ReviewComment>[]>
  onAddComment: (filePath: string, side: AnnotationSide, lineNumber: number, endLine: number, lineContent: string, body: string) => void
  onDeleteComment: (id: string) => void
  onReplyComment: (id: string, body: string) => void
}

export const DiffViewer = memo(
  forwardRef<CodeViewWrapperHandle, DiffViewerProps>(function DiffViewer(
    {
      files,
      diffStyle,
      defaultTabSize,
      viewedFiles,
      binaryFiles,
      onViewedChange,
      fileAnnotationsMap,
      onAddComment,
      onDeleteComment,
      onReplyComment,
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

    if (textFiles.length === 0 && binaryFileEntries.length === 0) {
      return (
        <div className="empty-state">
          <p>No changes found.</p>
        </div>
      )
    }

    return (
      <div className="diff-viewer">
        {binaryFileEntries.map(({ file, info }) => (
          <BinaryFileDiff
            key={file.name}
            filePath={file.name}
            info={info}
            viewed={viewedFiles.has(file.name)}
            onViewedChange={onViewedChange}
          />
        ))}
        {textFiles.length > 0 && (
          <CodeViewWrapper
            ref={ref}
            files={textFiles}
            diffStyle={diffStyle}
            defaultTabSize={defaultTabSize}
            viewedFiles={viewedFiles}
            fileAnnotationsMap={fileAnnotationsMap}
            onViewedChange={onViewedChange}
            onAddComment={onAddComment}
            onDeleteComment={onDeleteComment}
            onReplyComment={onReplyComment}
          />
        )}
      </div>
    )
  }),
)
