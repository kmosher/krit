import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { FileDiffMetadata } from '@pierre/diffs'
import {
  FileTree,
  buildTree,
  flattenTree,
  inferChangeType,
  getFileIcon,
  type FlatRow,
  type TreeNode,
} from './FileTree'

// Only `name` and the object-ids/prevName drive the tree and the change-type
// inference; `type` is required by the upstream interface but deliberately
// left as 'change' so the tests exercise the *inferred* path, which is what
// parsePatchFiles actually leaves the UI holding.
function meta(name: string, extra: Partial<FileDiffMetadata> = {}): FileDiffMetadata {
  return { name, type: 'change', ...extra } as FileDiffMetadata
}

const ZERO_SHORT = '0000000'
const ZERO_LONG = '0000000000000000000000000000000000000000'

/** `dir/dir/file` shape of a subtree, for asserting structure without the
 *  noise of every TreeNode field. */
function shape(nodes: TreeNode[]): string[] {
  const out: string[] = []
  const walk = (ns: TreeNode[], prefix: string) => {
    for (const n of ns) {
      const label = prefix + n.name + (n.isDir ? '/' : '')
      out.push(label)
      walk(n.children, prefix + '  ')
    }
  }
  walk(nodes, '')
  return out
}

function flatten(nodes: TreeNode[], collapsed: string[] = []): FlatRow[] {
  const out: FlatRow[] = []
  flattenTree(nodes, 0, new Set(collapsed), out)
  return out
}

describe('buildTree', () => {
  it('nests each path segment under a directory node carrying the full prefix path', () => {
    // `path` (not `name`) is the collapse key and the React key, so a deep
    // node's path has to be the joined prefix, not just its own segment.
    const tree = buildTree([meta('src/ui/App.tsx')])
    expect(shape(tree)).toEqual(['src/', '  ui/', '    App.tsx'])
    expect(tree[0].path).toBe('src')
    expect(tree[0].children[0].path).toBe('src/ui')
    expect(tree[0].children[0].children[0].path).toBe('src/ui/App.tsx')
  })

  it('merges siblings under one shared directory node instead of one per file', () => {
    const tree = buildTree([meta('src/a.ts'), meta('src/b.ts')])
    expect(shape(tree)).toEqual(['src/', '  a.ts', '  b.ts'])
  })

  it('keeps a chain of single-child directories as separate nodes', () => {
    // No path compression: each level is independently collapsible, so
    // `a/b/c/d.ts` must stay four rows deep rather than fusing to `a/b/c`.
    const tree = buildTree([meta('a/b/c/d.ts')])
    expect(shape(tree)).toEqual(['a/', '  b/', '    c/', '      d.ts'])
  })

  it('places a repo-root file alongside a deep tree, sorted after directories', () => {
    // Mixed depths are the common krit case (README.md next to src/…); the
    // comparator must put every directory ahead of every file regardless of
    // the input order.
    const tree = buildTree([meta('README.md'), meta('src/ui/App.tsx'), meta('Cargo.toml')])
    expect(shape(tree)).toEqual([
      'src/',
      '  ui/',
      '    App.tsx',
      'Cargo.toml',
      'README.md',
    ])
  })

  it('sorts directories before files at every depth, not just the root', () => {
    const tree = buildTree([meta('src/z.ts'), meta('src/nested/a.ts')])
    expect(shape(tree)).toEqual(['src/', '  nested/', '    a.ts', '  z.ts'])
  })

  it('sorts siblings by name independent of the input order', () => {
    const tree = buildTree([meta('src/c.ts'), meta('src/a.ts'), meta('src/b.ts')])
    expect(shape(tree)).toEqual(['src/', '  a.ts', '  b.ts', '  c.ts'])
  })

  it('attaches the metadata to leaves only', () => {
    // The row renderer reads `node.file?.name` as the click target and feeds
    // `node.file` to the icon; a directory must never carry one.
    const file = meta('src/a.ts')
    const tree = buildTree([file])
    expect(tree[0].file).toBeUndefined()
    expect(tree[0].children[0].file).toBe(file)
  })

  it('keeps a file and a directory that share a name as distinct nodes', () => {
    // `find` matches on name *and* isDir; without the isDir half, `docs`
    // the file would be reused as the parent of `docs/x.md` (or vice versa)
    // and one of the two would vanish from the tree.
    const tree = buildTree([meta('docs'), meta('docs/x.md')])
    expect(shape(tree)).toEqual(['docs/', '  x.md', 'docs'])
  })

  it('returns nothing for no files', () => {
    expect(buildTree([])).toEqual([])
  })

  it('keeps a non-ASCII path in one piece', () => {
    // The name reaching the tree is already un-C-quoted by parseFileFragment;
    // nothing here may re-split or re-encode it.
    const tree = buildTree([meta('src/café/naïve.rs')])
    expect(shape(tree)).toEqual(['src/', '  café/', '    naïve.rs'])
    expect(tree[0].children[0].children[0].path).toBe('src/café/naïve.rs')
  })

  it('treats a quote character in a filename as an ordinary character', () => {
    // Regression shape: when C-quoted names leaked through unstripped, the
    // surrounding quotes were parsed as part of the first/last segment and
    // produced bogus folder nodes like `"src`. A real quote inside a name
    // must still be just a name character.
    const tree = buildTree([meta('src/say "hi".txt')])
    expect(shape(tree)).toEqual(['src/', '  say "hi".txt'])
  })

  it('treats a rename as a single node at its new path', () => {
    // Renames arrive with prevName set; the old location must not also
    // appear in the tree, or the reviewer sees a phantom file.
    const tree = buildTree([meta('src/new.ts', { prevName: 'src/old.ts' })])
    expect(shape(tree)).toEqual(['src/', '  new.ts'])
  })

  it('does not duplicate a node when the same path appears twice', () => {
    const tree = buildTree([meta('src/a.ts'), meta('src/a.ts')])
    expect(shape(tree)).toEqual(['src/', '  a.ts'])
  })
})

describe('flattenTree', () => {
  it('emits depth-first rows with the depth each row should be indented to', () => {
    const rows = flatten(buildTree([meta('src/ui/App.tsx'), meta('README.md')]))
    expect(rows.map((r) => [r.type, r.node.name, r.depth])).toEqual([
      ['dir', 'src', 0],
      ['dir', 'ui', 1],
      ['file', 'App.tsx', 2],
      ['file', 'README.md', 0],
    ])
  })

  it('drops the subtree of a collapsed directory but keeps the directory row', () => {
    const rows = flatten(buildTree([meta('src/a.ts'), meta('README.md')]), ['src'])
    expect(rows.map((r) => r.node.name)).toEqual(['src', 'README.md'])
  })

  it('collapses by full path, so a nested dir sharing a name stays expanded', () => {
    // `collapsedDirs` holds paths; keying it on the bare segment would make
    // collapsing `src/ui` also collapse an unrelated `docs/ui`.
    const tree = buildTree([meta('src/ui/a.ts'), meta('docs/ui/b.md')])
    const rows = flatten(tree, ['src/ui'])
    expect(rows.map((r) => r.node.path)).toEqual([
      'docs',
      'docs/ui',
      'docs/ui/b.md',
      'src',
      'src/ui',
    ])
  })

  it('hides a whole branch when an ancestor is collapsed, not just one level', () => {
    const rows = flatten(buildTree([meta('a/b/c/d.ts')]), ['a'])
    expect(rows.map((r) => r.node.path)).toEqual(['a'])
  })

  it('ignores a collapse entry for a path that is not a directory', () => {
    // Stale entries survive in state after a file disappears from the diff;
    // they must not swallow the file's row.
    const rows = flatten(buildTree([meta('src/a.ts')]), ['src/a.ts'])
    expect(rows.map((r) => r.node.path)).toEqual(['src', 'src/a.ts'])
  })
})

describe('inferChangeType', () => {
  it('reports untracked ahead of everything else', () => {
    // An untracked file is synthesized with an all-zero prev id, which would
    // otherwise read as 'new'; the reviewer needs the two distinguished.
    const file = meta('new.ts', { prevObjectId: ZERO_SHORT, newObjectId: 'abc1234' })
    expect(inferChangeType(file, new Set(['new.ts']))).toBe('untracked')
  })

  it('reports a rename before consulting object ids', () => {
    expect(inferChangeType(meta('b.ts', { prevName: 'a.ts' }), new Set())).toBe('rename-changed')
  })

  it('still reports untracked when a rename is also claimed', () => {
    // A degenerate input — git cannot rename into an untracked path — but it
    // pins the guard order: untracked is the outermost check, so no later
    // heuristic can relabel a file the server said is not in the index.
    const file = meta('b.ts', { prevName: 'a.ts' })
    expect(inferChangeType(file, new Set(['b.ts']))).toBe('untracked')
  })

  it('reads an all-zero prev object id as an addition, in both id widths', () => {
    // git writes abbreviated ids in `index` lines but full ids elsewhere;
    // only the exact literals are recognized, so both must be covered.
    for (const zero of [ZERO_SHORT, ZERO_LONG]) {
      expect(inferChangeType(meta('a.ts', { prevObjectId: zero, newObjectId: 'abc1234' }), new Set())).toBe('new')
    }
  })

  it('reads an all-zero new object id as a deletion, in both id widths', () => {
    for (const zero of [ZERO_SHORT, ZERO_LONG]) {
      expect(inferChangeType(meta('a.ts', { prevObjectId: 'abc1234', newObjectId: zero }), new Set())).toBe('deleted')
    }
  })

  it('falls back to a plain change when both ids are real', () => {
    expect(inferChangeType(meta('a.ts', { prevObjectId: 'abc1234', newObjectId: 'def5678' }), new Set())).toBe('change')
  })

  it('falls back to a plain change when the ids are missing entirely', () => {
    expect(inferChangeType(meta('a.ts'), new Set())).toBe('change')
  })

  it('matches untracked on the full path, not a suffix', () => {
    expect(inferChangeType(meta('src/a.ts'), new Set(['a.ts']))).toBe('change')
  })
})

describe('getFileIcon', () => {
  const classOf = (el: ReturnType<typeof getFileIcon>) =>
    (el.props as { className: string }).className

  it('shows the viewed check regardless of the underlying change type', () => {
    // Viewed is a review-progress signal and deliberately outranks the
    // change type, so a viewed new file still reads as done.
    const file = meta('a.ts', { prevObjectId: ZERO_SHORT })
    expect(classOf(getFileIcon(file, true, new Set()))).toContain('icon-viewed')
  })

  it('maps each inferred change type to its own icon class', () => {
    const cases: Array<[FileDiffMetadata, Set<string>, string]> = [
      [meta('a.ts', { prevObjectId: ZERO_SHORT }), new Set(), 'icon-added'],
      [meta('a.ts'), new Set(['a.ts']), 'icon-untracked'],
      [meta('a.ts', { newObjectId: ZERO_SHORT }), new Set(), 'icon-deleted'],
      [meta('a.ts', { prevName: 'b.ts' }), new Set(), 'icon-renamed'],
      [meta('a.ts'), new Set(), 'icon-modified'],
    ]
    for (const [file, untracked, cls] of cases) {
      expect(classOf(getFileIcon(file, false, untracked))).toContain(cls)
    }
  })

  it('falls back to the modified icon when a row has no metadata', () => {
    expect(classOf(getFileIcon(undefined, false, new Set()))).toContain('icon-modified')
  })
})

function renderTree(props: Partial<Parameters<typeof FileTree>[0]> = {}) {
  const onFileClick = vi.fn()
  const utils = render(
    <FileTree
      files={[meta('src/ui/App.tsx'), meta('README.md')]}
      activeFile={null}
      commentCounts={{}}
      fileStatsMap={{}}
      viewedFiles={new Set()}
      untrackedFiles={new Set()}
      onFileClick={onFileClick}
      {...props}
    />,
  )
  return { ...utils, onFileClick }
}

describe('<FileTree>', () => {
  it('lists every directory and file row', () => {
    const { container } = renderTree()
    expect([...container.querySelectorAll('.ft-dir-name')].map((n) => n.textContent)).toEqual([
      'src',
      'ui',
    ])
    expect([...container.querySelectorAll('.ft-file-name')].map((n) => n.textContent)).toEqual([
      'App.tsx',
      'README.md',
    ])
  })

  it('marks viewed files so the reviewer can see progress at a glance', () => {
    const { container } = renderTree({ viewedFiles: new Set(['README.md']) })
    const viewed = [...container.querySelectorAll('.ft-file-viewed .ft-file-name')]
    expect(viewed.map((n) => n.textContent)).toEqual(['README.md'])
    expect(container.querySelector('.icon-viewed')).not.toBeNull()
  })

  it('marks the active file', () => {
    const { container } = renderTree({ activeFile: 'src/ui/App.tsx' })
    expect(container.querySelector('.ft-file-active .ft-file-name')?.textContent).toBe('App.tsx')
  })

  it('reports the full path — not the leaf name — when a file is clicked', () => {
    const { container, onFileClick } = renderTree()
    fireEvent.click(container.querySelector('.ft-file')!)
    expect(onFileClick).toHaveBeenCalledWith('src/ui/App.tsx')
  })

  it('hides and restores a directory subtree when its row is clicked', () => {
    const { container } = renderTree()
    const srcRow = container.querySelector('.ft-dir')!
    fireEvent.click(srcRow)
    expect([...container.querySelectorAll('.ft-file-name')].map((n) => n.textContent)).toEqual([
      'README.md',
    ])
    fireEvent.click(container.querySelector('.ft-dir')!)
    expect(container.querySelectorAll('.ft-file-name')).toHaveLength(2)
  })

  it('does not select a file when a directory is clicked', () => {
    const { container, onFileClick } = renderTree()
    fireEvent.click(container.querySelector('.ft-dir')!)
    expect(onFileClick).not.toHaveBeenCalled()
  })

  it('filters on the whole path, case-insensitively', () => {
    // Typing a directory name has to keep its files, so the filter matches
    // the full path rather than the leaf name.
    const { container } = renderTree()
    fireEvent.change(screen.getByPlaceholderText('Filter files...'), {
      target: { value: 'SRC/' },
    })
    expect([...container.querySelectorAll('.ft-file-name')].map((n) => n.textContent)).toEqual([
      'App.tsx',
    ])

    // Lowercase query against an uppercase path: both sides must be folded,
    // or filtering silently misses SHOUTING filenames like README.md.
    fireEvent.change(screen.getByPlaceholderText('Filter files...'), {
      target: { value: 'readme' },
    })
    expect([...container.querySelectorAll('.ft-file-name')].map((n) => n.textContent)).toEqual([
      'README.md',
    ])
  })

  it('applies only the clicked file when its stale dot is used', () => {
    // The dot's handler stops propagation: refreshing one file must not also
    // navigate to it, which would move the reviewer out from under themselves.
    const onApplyStale = vi.fn()
    const { container, onFileClick } = renderTree({
      staleFiles: new Set(['README.md']),
      onApplyStale,
    })
    fireEvent.click(container.querySelector('.ft-stale-dot')!)
    expect(onApplyStale).toHaveBeenCalledWith('README.md')
    expect(onFileClick).not.toHaveBeenCalled()
  })

  it('shows only the expand button when collapsed', () => {
    const { container } = renderTree({ collapsed: true, onToggleCollapse: vi.fn() })
    expect(container.querySelectorAll('.ft-file-name')).toHaveLength(0)
    expect(screen.getByLabelText('Expand sidebar')).toBeTruthy()
  })
})
