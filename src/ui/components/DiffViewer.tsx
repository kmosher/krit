import type { FileDiffMetadata, DiffLineAnnotation, AnnotationSide } from '@pierre/diffs'
import type { ReviewComment } from '../../types'
import type { BinaryFileInfo } from '../hooks/useDiff'
import { FileDiffCard } from './FileDiffCard'
import { BinaryFileDiff } from './BinaryFileDiff'

interface DiffViewerProps {
  files: FileDiffMetadata[]
  diffStyle: 'split' | 'unified'
  tabSizeMap: Record<string, number>
  viewedFiles: Set<string>
  binaryFiles: Map<string, BinaryFileInfo>
  onViewedChange: (filePath: string, viewed: boolean) => void
  getAnnotationsForFile: (filePath: string) => DiffLineAnnotation<ReviewComment>[]
  onAddComment: (filePath: string, side: AnnotationSide, lineNumber: number, lineContent: string, body: string) => void
  onDeleteComment: (id: string) => void
}

export function DiffViewer({
  files,
  diffStyle,
  tabSizeMap,
  viewedFiles,
  binaryFiles,
  onViewedChange,
  getAnnotationsForFile,
  onAddComment,
  onDeleteComment,
}: DiffViewerProps) {
  if (files.length === 0) {
    return (
      <div className="empty-state">
        <p>No changes found.</p>
      </div>
    )
  }

  return (
    <div className="diff-viewer">
      {files.map((file, index) => {
        const filePath = file.name
        const binaryInfo = binaryFiles.get(filePath)
        if (binaryInfo) {
          return (
            <BinaryFileDiff
              key={`${filePath}-${index}`}
              filePath={filePath}
              info={binaryInfo}
              viewed={viewedFiles.has(filePath)}
              onViewedChange={onViewedChange}
            />
          )
        }
        return (
          <FileDiffCard
            key={`${filePath}-${index}`}
            id={`file-${filePath}`}
            fileDiff={file}
            filePath={filePath}
            annotations={getAnnotationsForFile(filePath)}
            diffStyle={diffStyle}
            tabSize={tabSizeMap[filePath] ?? 4}
            viewed={viewedFiles.has(filePath)}
            onViewedChange={onViewedChange}
            onAddComment={onAddComment}
            onDeleteComment={onDeleteComment}
          />
        )
      })}
    </div>
  )
}
