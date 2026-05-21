import { execFileSync } from 'node:child_process'
import { basename, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { isSafePath } from './path.js'
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
  if (!isSafePath(filePath, root)) {
    return null
  }
  const resolved = resolve(root, filePath)
  if (version === 'new') {
    try {
      return readFileSync(resolved)
    } catch {
      return null
    }
  }
  // old version: try staged first, then HEAD
  try {
    return execFileSync('git', ['show', `HEAD:${filePath}`], { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 })
  } catch {
    return null
  }
}

/**
 * Sentinels for the two non-ref content sources we surface alongside named git refs:
 *   - WORKING_TREE: the on-disk file (what `readFileSync` returns).
 *   - INDEX: the staged version (what `git show :path` returns).
 * Everything else is treated as a git revision and passed to `git show <ref>:path`.
 */
export const WORKING_TREE_REF = 'WORKING_TREE'
export const INDEX_REF = 'INDEX'

export function getFileContentAtRef(filePath: string, ref: string): Buffer | null {
  const root = getRepoRoot()
  if (!isSafePath(filePath, root)) return null
  if (ref === WORKING_TREE_REF) {
    try {
      return readFileSync(resolve(root, filePath))
    } catch {
      return null
    }
  }
  // Both INDEX and named refs go through `git show`. Index is `git show :path`
  // (no ref prefix). Named refs are `git show <ref>:path`. The 50MB cap matches
  // the legacy getFileContent — large enough for any sane source file, small
  // enough to prevent obvious DOSing.
  const spec = ref === INDEX_REF ? `:${filePath}` : `${ref}:${filePath}`
  try {
    return execFileSync('git', ['show', spec], { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 })
  } catch {
    return null
  }
}

/**
 * Resolve a diffx invocation to the (old, new) refs the patch was computed against,
 * so we can serve the matching file contents for hunk expansion.
 *
 * Mirrors what `git diff` itself does with these arg shapes:
 *   - (none)              → working tree vs HEAD               → old=HEAD,            new=WORKING_TREE
 *   - --staged / --cached → index vs HEAD                      → old=HEAD,            new=INDEX
 *   - <rev>               → working tree vs <rev>              → old=<rev>,           new=WORKING_TREE
 *   - <rev1> <rev2>       → <rev2> vs <rev1>                   → old=<rev1>,          new=<rev2>
 *   - <rev1>..<rev2>      → same as above                      → old=<rev1>,          new=<rev2>
 *   - <rev1>...<rev2>     → <rev2> vs merge-base(<rev1>,<rev2>)→ old=mergeBase(...),  new=<rev2>
 *
 * Anything we can't parse falls back to the working-tree default; the client only
 * uses these for context-line expansion, so an incorrect ref renders as "this file
 * has no diff" — annoying but not corrupting.
 */
export function resolveDiffRefs(
  customDiffArgs: string[] | undefined,
): { baseRef: string; headRef: string } {
  const args = customDiffArgs ?? []
  const positionals: string[] = []
  let staged = false
  let pastDashDash = false
  for (const a of args) {
    if (pastDashDash) continue // everything after `--` is a pathspec, not a ref
    if (a === '--') { pastDashDash = true; continue }
    if (a === '--staged' || a === '--cached') { staged = true; continue }
    if (a.startsWith('-')) continue // any other git-diff flag (e.g. --ignore-whitespace)
    positionals.push(a)
  }
  if (staged) return { baseRef: 'HEAD', headRef: INDEX_REF }
  if (positionals.length === 0) return { baseRef: 'HEAD', headRef: WORKING_TREE_REF }
  if (positionals.length === 1) {
    const a = positionals[0]
    if (a.includes('...')) {
      const [x, y] = a.split('...')
      const head = y || 'HEAD'
      try {
        const mergeBase = execFileSync('git', ['merge-base', x, head], { stdio: 'pipe' })
          .toString()
          .trim()
        return { baseRef: mergeBase, headRef: head }
      } catch {
        return { baseRef: x, headRef: head }
      }
    }
    if (a.includes('..')) {
      const [x, y] = a.split('..')
      return { baseRef: x, headRef: y || 'HEAD' }
    }
    return { baseRef: a, headRef: WORKING_TREE_REF }
  }
  // 2+ positionals: treat first two as refs (git diff's own behavior; extra positionals
  // would be pathspecs and we ignore them for ref resolution).
  return { baseRef: positionals[0], headRef: positionals[1] }
}

export function isGitRepo(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export function getRepoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  }).trim()
}

export function getRepoName(): string {
  return basename(getRepoRoot())
}

export function getBranchName(): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe', encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

// Force standard unified diff regardless of user's git config
// (e.g. diff.external = difftastic, color.ui = always).
const DIFF_FLAGS = ['--no-ext-diff', '--no-color'] as const

export function getCustomGitDiff(args: string[]): string {
  return execFileSync('git', ['diff', ...DIFF_FLAGS, ...args], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
}

export function getGitDiff(options: { staged?: boolean; untracked?: boolean } = {}): string {
  const parts: string[] = []

  // unstaged changes (always included as the base)
  const unstaged = execFileSync('git', ['diff', ...DIFF_FLAGS], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
  if (unstaged) parts.push(unstaged)

  // staged changes
  if (options.staged) {
    const staged = execFileSync('git', ['diff', ...DIFF_FLAGS, '--staged'], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
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

export function getUntrackedFilePaths(): string[] {
  const output = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  }).trim()
  return output ? output.split('\n') : []
}

function getUntrackedFilesDiff(): string {
  const root = getRepoRoot()
  const output = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
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
        const diffLines = lines.map((l: string) => `+${l}`)
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
