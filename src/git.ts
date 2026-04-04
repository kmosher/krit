import { execSync } from 'node:child_process'
import { basename } from 'node:path'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSync as parseEditorConfig, type ProcessedFileConfig } from 'editorconfig'

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif',
])

export function isImageFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

function isBinaryFile(absolutePath: string): boolean {
  try {
    const buffer = readFileSync(absolutePath)
    const bytesToCheck = Math.min(buffer.length, 8192)
    for (let i = 0; i < bytesToCheck; i++) {
      if (buffer[i] === 0) return true
    }
    return false
  } catch {
    return true
  }
}

export function getFileContent(filePath: string, version: 'old' | 'new'): Buffer | null {
  const root = getRepoRoot()
  if (version === 'new') {
    try {
      return readFileSync(join(root, filePath))
    } catch {
      return null
    }
  }
  // old version: try staged first, then HEAD
  try {
    return execSync(`git show HEAD:${filePath}`, { maxBuffer: 50 * 1024 * 1024 })
  } catch {
    return null
  }
}

export function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export function getRepoRoot(): string {
  return execSync('git rev-parse --show-toplevel', {
    encoding: 'utf-8',
  }).trim()
}

export function getRepoName(): string {
  return basename(getRepoRoot())
}

export function getBranchName(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

export function getCustomGitDiff(args: string[]): string {
  const cmd = ['git', 'diff', ...args].join(' ')
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
}

export function getGitDiff(options: { staged?: boolean; untracked?: boolean } = {}): string {
  const parts: string[] = []

  // unstaged changes (always included as the base)
  const unstaged = execSync('git diff', { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
  if (unstaged) parts.push(unstaged)

  // staged changes
  if (options.staged) {
    const staged = execSync('git diff --staged', { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
    if (staged) parts.push(staged)
  }

  // untracked files
  if (options.untracked) {
    const untrackedPatch = getUntrackedFilesDiff()
    if (untrackedPatch) parts.push(untrackedPatch)
  }

  return parts.join('\n')
}

export function getTabSizeForFiles(filePaths: string[]): Record<string, number> {
  const root = getRepoRoot()
  const cache = new Map<string, ProcessedFileConfig>()
  const result: Record<string, number> = {}
  for (const filePath of filePaths) {
    try {
      const absPath = join(root, filePath)
      const config = parseEditorConfig(absPath, { cache })
      const size = config.tab_width ?? (config.indent_size === 'tab' ? undefined : config.indent_size)
      if (typeof size === 'number') {
        result[filePath] = size
      }
    } catch {
      // skip files that fail to resolve
    }
  }
  return result
}

function getUntrackedFilesDiff(): string {
  const root = getRepoRoot()
  const output = execSync('git ls-files --others --exclude-standard', {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  }).trim()

  if (!output) return ''

  const files = output.split('\n')
  const patches: string[] = []

  for (const file of files) {
    const absolutePath = join(root, file)
    if (isBinaryFile(absolutePath)) {
      const patch = [
        `diff --git a/${file} b/${file}`,
        'new file mode 100644',
        'index 0000000..0000001',
        `Binary files /dev/null and b/${file} differ`,
      ].join('\n')
      patches.push(patch)
    } else {
      try {
        const content = readFileSync(absolutePath, 'utf-8')
        const lines = content.split('\n')
        const diffLines = lines.map((line) => `+${line}`)
        const patch = [
          `diff --git a/${file} b/${file}`,
          'new file mode 100644',
          'index 0000000..0000001',
          '--- /dev/null',
          `+++ b/${file}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...diffLines,
        ].join('\n')
        patches.push(patch)
      } catch {
        // skip unreadable files
      }
    }
  }

  return patches.length > 0 ? '\n' + patches.join('\n') : ''
}
