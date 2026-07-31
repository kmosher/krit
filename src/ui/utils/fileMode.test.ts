import { describe, expect, it } from 'vitest'
import { processPatch } from '@pierre/diffs'
import { modeChangeOf } from './fileMode'

// Real `git diff` output, lifted verbatim from the "everything" demo repo —
// the one this bug first surfaced in. Hand-written patch text would be a
// statement about what git is believed to emit, and the whole point of these
// cases is that git's metadata lines are easy to remember wrongly.
const PATCH = `diff --git a/assets/icon.png b/assets/icon.png
new file mode 100644
index 0000000..f37764b
Binary files /dev/null and b/assets/icon.png differ
diff --git a/docs/guide.md b/docs/guide.md
index 5d8edf3..8dc21fd 100644
--- a/docs/guide.md
+++ b/docs/guide.md
@@ -14,3 +14,7 @@ A short document, so the Markdown preview has something to render.
 | --- | --- |
 | one | the first |
 | two | the second |
+
+## Troubleshooting
+
+If it does not work, read the error message.
diff --git a/old_name.txt b/new_name.txt
similarity index 100%
rename from old_name.txt
rename to new_name.txt
diff --git a/removed.txt b/removed.txt
deleted file mode 100644
index 276e7b7..0000000
--- a/removed.txt
+++ /dev/null
@@ -1 +0,0 @@
-this file goes away
diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
`

const byName = new Map(processPatch(PATCH).files.map((f) => [f.name, f]))

function file(name: string) {
  const f = byName.get(name)
  if (!f) throw new Error(`no ${name} in patch; parsed: ${[...byName.keys()].join(', ')}`)
  return f
}

describe('modeChangeOf', () => {
  it('reports the pair for a mode-only change', () => {
    expect(modeChangeOf(file('script.sh'))).toEqual({ from: '100644', to: '100755' })
  })

  // The file with no body at all is the whole reason this exists: nothing else
  // in the header would say why it is in the review.
  it('the mode-only file really does arrive with no hunks', () => {
    expect(file('script.sh').hunks).toHaveLength(0)
  })

  // The load-bearing case. The `index` line carries a mode too, so every
  // ordinary modified file has `mode` set — testing `prevMode == null` alone,
  // or truthiness of `mode`, would label the entire review as mode changes.
  it('says nothing for an ordinary content change, whose index line sets a mode', () => {
    expect(file('docs/guide.md').mode).toBe('100644')
    expect(modeChangeOf(file('docs/guide.md'))).toBeNull()
  })

  it('says nothing for a pure rename', () => {
    expect(modeChangeOf(file('new_name.txt'))).toBeNull()
  })

  // `new file mode` / `deleted file mode` set `mode` alone and are the change
  // *kind*, which the header's own pill already states.
  it('says nothing for an added or deleted file', () => {
    expect(modeChangeOf(file('assets/icon.png'))).toBeNull()
    expect(modeChangeOf(file('removed.txt'))).toBeNull()
  })

  it('says nothing when the two halves agree', () => {
    expect(modeChangeOf({ mode: '100644', prevMode: '100644' })).toBeNull()
  })
})
