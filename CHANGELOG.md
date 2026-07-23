# Changelog

## 0.14.0

### Minor Changes

- d58fd10: Desktop app launcher — diffx can now open each review in its own window of a
  dedicated **diffx** macOS app instead of a tab in your default browser. Set
  `"launcher": "app"` in `~/.config/diffx/settings.json` and the CLI fires a
  `diffx://review?url=…` deep link; the app (under `desktop/`, a thin Tauri shell)
  turns each link into a window keyed by the review's server port, so multiple
  reviews in flight become multiple windows under one dock icon. With the app not
  installed, or the setting left at its `browser` default, behavior is unchanged —
  and a failed deep link degrades to the usual "visit this URL" hint.

  Build the app from `desktop/` (see `desktop/README.md`); the launcher setting is
  the only change to the published `diffx-cli` package itself.

- 36e6c2c: Inline rewrite suggestions — every comment form now has a **Suggest edit** toggle that pre-fills a syntax-highlighted CodeMirror editor with the selected lines. Submitting captures both the original lines and the rewrite; the comment bubble shows them as an inline old/new diff. `Copy comments` emits each suggestion as a GitHub-style ` ```suggestion ` fence inside `<suggestion>` tags so an attached agent can recognize and apply it.

  In-browser file editor — each diff header gains an **Edit** button that opens a fullscreen modal seeded with the file's current working-tree contents. Save writes back to disk via a new `PUT /api/file-content` endpoint and broadcasts a `file-written` SSE so the diff refreshes immediately. The editor is CodeMirror, with syntax highlighting, line numbers, and code folding.

  Gutter & drag fixes —

  - `+` button now tracks hover instead of sticking to the most-recently-clicked line. Line selection stays on (so drag-to-select shows live highlight), but `onLineEnter` auto-clears the selection when the cursor leaves the selected range. `onLineSelectionStart`/`End` gate the clear so it can't fire mid-drag and wipe the in-progress range.
  - Drag-the-`+` in split view no longer disappears. The lib anchors `+` on one column and coordinate-resolves the drag endpoint on the other, producing a cross-side range that was previously rejected. We commit to whichever side the drag ended on.
  - Multi-line ranges captured for comments and suggestions no longer have doubled `\n\n` between rows. `getRangeContent` strips per-row trailing newlines before joining.

  Skill renamed — `skills/diffx-review/` → `skills/diffx/`, and the user-invocable name is now `/diffx` (was `/diffx-review`). The CLI hint text and README references are updated.

### Patch Changes

- 624ff8e: Fix binary previews pinning the code out of view. Binary files (images, etc.)
  render outside CodeView's scroller, and a tall stack of image previews — say a
  diff that adds an app icon set — would fill the viewport and trap the code
  scroller below the fold, unreachable until each image was marked viewed. They
  now live in their own height-capped, scrollable band (and individual previews
  are smaller), so the code is always reachable.

## 0.13.0

### Minor Changes

- 492421f: Expandable context — each file card now lets you expand unedited lines above, below, and between hunks once both file versions have loaded. Contents are fetched lazily as the file scrolls into view (200px rootMargin) via a new ref-aware `/api/file-text?path&ref` endpoint; `/api/diff` exposes the resolved `baseRef`/`headRef` so expansion works with arbitrary `git diff` argument shapes (`HEAD~N`, `X..Y`, `X...Y`, `X Y`, `--staged`). Files larger than 5 MB show a "Load anyway" opt-in instead of streaming the bytes by default.
- 492421f: Multi-line range comments — drag the gutter `+` across several lines to comment on a span instead of a single row. Range comments persist as `lineNumber..endLine` and the copy-comments XML now carries an `endLine` attribute (root bumped to `version="2"`, content is XML-escaped). User replies from the browser — every comment bubble has a Reply button; user replies are tagged `author: 'user'` and auto-reopen the comment if it had been resolved. The CLI's launch output now says explicitly that diffx is _waiting_ for inline comments, and the wire event for replies carries `commentStatus` so a watching agent doesn't need to re-fetch to learn about auto-reopens.
- 492421f: Session-aware CLI subcommands (`diffx state`, `comments`, `reply`, `resolve`, `reopen`, `watch`, `wait-for-submit`) let an attached agent process review comments as they arrive. The browser UI gains a "Done reviewing" Submit button that fires a one-shot SSE pulse to any waiting watcher. The `/diffx-start-review` + `/diffx-finish-review` skill pair is replaced by a single streaming `/diffx-review` skill.

## 0.12.1

### Patch Changes

- 7779d85: add browser setting

## 0.12.0

### Minor Changes

- 93b20e5: Add collapsible sidebar with toggle button next to the file filter input

## 0.11.0

### Minor Changes

- 0a4f752: add `--host` flag to bind the server to a custom address (e.g. `0.0.0.0` for LAN access)

## 0.10.0

### Minor Changes

- b76c8b6: Add comment status tracker in sidebar with open/replied/resolved status indicators and click-to-navigate via anchor links
- 6c3d7db: Distinguish untracked files from added files with a separate FileQuestion icon

## 0.9.0

### Minor Changes

- 39340d9: add comment replies support

## 0.8.3

### Patch Changes

- 7e42d1b: Fix button hover state where background color collides with foreground text color

## 0.8.2

### Patch Changes

- 129a23b: All internal `git diff` invocations now pass `--no-ext-diff --no-color`, so the frontend always receives a standard unified diff regardless of the user's global git configuration.

## 0.8.1

### Patch Changes

- 2a97d9b: Harden local server exposure by binding DiffX to loopback only and reduce command execution risk by replacing shell-based Git invocation with `execFileSync`.

## 0.8.0

### Minor Changes

- 5849f1b: Fix path traversal vulnerability and use random port by default

## 0.7.0 (2026-04-04)

- Persist "Viewed" file state in server memory across page refreshes

## 0.6.0 (2026-04-04)

- Support per-file tab size from `.editorconfig`
- Add settings dropdown to toolbar with default tab size option

## 0.5.0 (2026-04-04)

- Add binary file detection and image preview support
- Split review skill into start/finish workflow with comment status tracking
- Add `prepublishOnly` script

## 0.4.3 (2026-04-04)

- Add GitHub links to package.json and fix screenshot URL for npm
- Reduce font size of staged/untracked checkboxes in toolbar

## 0.4.2 (2026-04-04)

- Fix bin path to match tsdown ESM output (.mjs)

## 0.4.1 (2026-04-04)

- Add diffx-review skill for AI-assisted code review workflow

## 0.4.0 (2026-04-04)

- Add `--help` and `--version`/`-v` flags to CLI

## 0.3.0 (2026-04-04)

- Move comments from client-only state to server-side storage with API
- Add screenshot to README

## 0.2.1 (2026-04-04)

- Replace deprecated `external` with `deps.neverBundle` in tsdown config

## 0.2.0 (2026-04-04)

- Use XML format for copied comments with inline code context

## 0.1.0 (2026-04-04)

- Initial release
