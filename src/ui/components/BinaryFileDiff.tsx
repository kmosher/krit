import type { BinaryFileInfo } from '../hooks/useDiff'

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif',
])

function isImage(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

interface BinaryFileDiffProps {
  filePath: string
  info: BinaryFileInfo
  viewed: boolean
  onViewedChange: (filePath: string, viewed: boolean) => void
}

export function BinaryFileDiff({ filePath, info, viewed, onViewedChange }: BinaryFileDiffProps) {
  const image = isImage(filePath)

  return (
    <div className={`file-diff-card ${viewed ? 'file-diff-viewed' : ''}`} id={`file-${filePath}`}>
      <div className="binary-diff-header">
        <span className="binary-diff-name">{filePath}</span>
        <label className="viewed-label" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={viewed}
            onChange={(e) => onViewedChange(filePath, e.target.checked)}
          />
          Viewed
        </label>
      </div>
      {!viewed && (
        <div className="binary-diff-body">
          {image ? (
            <ImagePreview filePath={filePath} changeType={info.type} />
          ) : (
            <div className="binary-diff-message">
              Binary file {info.type === 'added' ? 'added' : info.type === 'untracked' ? 'untracked' : info.type === 'deleted' ? 'deleted' : 'changed'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ImagePreview({ filePath, changeType }: { filePath: string; changeType: BinaryFileInfo['type'] }) {
  const oldSrc = `/api/file-content?path=${encodeURIComponent(filePath)}&version=old`
  const newSrc = `/api/file-content?path=${encodeURIComponent(filePath)}&version=new`

  if (changeType === 'added' || changeType === 'untracked') {
    return (
      <div className="image-preview">
        <div className="image-preview-panel">
          <div className="image-preview-label image-preview-label-added">Added</div>
          <img src={newSrc} alt={filePath} className="image-preview-img" />
        </div>
      </div>
    )
  }

  if (changeType === 'deleted') {
    return (
      <div className="image-preview">
        <div className="image-preview-panel">
          <div className="image-preview-label image-preview-label-deleted">Deleted</div>
          <img src={oldSrc} alt={filePath} className="image-preview-img image-preview-deleted" />
        </div>
      </div>
    )
  }

  return (
    <div className="image-preview image-preview-compare">
      <div className="image-preview-panel">
        <div className="image-preview-label">Before</div>
        <img src={oldSrc} alt={`${filePath} (before)`} className="image-preview-img" />
      </div>
      <div className="image-preview-panel">
        <div className="image-preview-label">After</div>
        <img src={newSrc} alt={`${filePath} (after)`} className="image-preview-img" />
      </div>
    </div>
  )
}
