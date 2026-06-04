---
"diffx-cli": minor
---

Inline rewrite suggestions — every comment form now has a **Suggest edit** toggle that pre-fills a syntax-highlighted CodeMirror editor with the selected lines. Submitting captures both the original lines and the rewrite; the comment bubble shows them as an inline old/new diff. `Copy comments` emits each suggestion as a GitHub-style ` ```suggestion ` fence inside `<suggestion>` tags so an attached agent can recognize and apply it.

In-browser file editor — each diff header gains an **Edit** button that opens a fullscreen modal seeded with the file's current working-tree contents. Save writes back to disk via a new `PUT /api/file-content` endpoint and broadcasts a `file-written` SSE so the diff refreshes immediately. The editor is CodeMirror, with syntax highlighting, line numbers, and code folding.

Gutter & drag fixes —

- `+` button now tracks hover instead of sticking to the most-recently-clicked line. Line selection stays on (so drag-to-select shows live highlight), but `onLineEnter` auto-clears the selection when the cursor leaves the selected range. `onLineSelectionStart`/`End` gate the clear so it can't fire mid-drag and wipe the in-progress range.
- Drag-the-`+` in split view no longer disappears. The lib anchors `+` on one column and coordinate-resolves the drag endpoint on the other, producing a cross-side range that was previously rejected. We commit to whichever side the drag ended on.
- Multi-line ranges captured for comments and suggestions no longer have doubled `\n\n` between rows. `getRangeContent` strips per-row trailing newlines before joining.

Skill renamed — `skills/diffx-review/` → `skills/diffx/`, and the user-invocable name is now `/diffx` (was `/diffx-review`). The CLI hint text and README references are updated.
