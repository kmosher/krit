# krit — agent notes

`krit/` is the Rust server; `src/ui/` (React, Pierre CodeView) is the web
UI it embeds; `src/types.ts` is the comment schema both share. `desktop/`
is the Tauri app (krit.app) that claims the `krit://` scheme. The HTTP/WS
API descends from v1 diffx (wong2's, later this repo's TS CLI — removed
2026-07), which is why some shapes look the way they do; it is not a
constraint. Change the wire freely, and move the server, the UI and the
skill together when you do.

## Edit loops

- **UI against a live server**: debug-build krit serves `dist/client` from
  disk — `pnpm exec vite build` then refresh the browser; no server restart.
  Release builds **embed** dist at compile time (`krit/build.rs` auto-rebuilds
  it when `src/ui` is newer; `KRIT_SKIP_UI_BUILD=1` opts out).
- `just` has the entry points: `install` / `test` / `check` / `ui` / `dev`.
  `just test` runs cargo tests, `tsc --noEmit`, and the Vitest UI suite.
- UI unit tests are Vitest (`pnpm exec vitest run`, or `vitest` to watch),
  co-located as `*.test.ts(x)` beside their source. It reuses `vite.config.ts`
  (the `test` block) so what builds is what tests. Pure logic is tested
  directly; hooks/components via `@testing-library/react` under happy-dom.
  Keep testable logic as exported pure functions (see `spliceFilePatches`/
  `splitFilePatches`, `computeRowWindow`, App's patch-fragment helpers).
- Fresh worktrees have no `dist/` — build.rs handles it, but the vite build
  needs `node_modules` (symlink from canonical or `pnpm install`).
- **Driving the UI in a real browser.** Vitest under happy-dom cannot test the
  selection path at all: no layout, so no `caretPositionFromPoint`, no
  `ShadowRoot.elementFromPoint`, every rect zero. Anything about pointers,
  carets or geometry has to be proven in a real engine — Playwright WebKit is
  the closest stand-in for the WKWebView krit.app embeds, and its `page.mouse`
  produces trusted events.
  - **Hit-test every coordinate before using it.** A point derived from a text
    node's `getBoundingClientRect()` is not good enough; feed it back through
    `document.caretPositionFromPoint(x, y, {shadowRoots: [root]})` and require
    `root.contains(offsetNode)`. Four false failures in one session came from
    unvalidated points: a y over the sticky file header, a line scrolled out of
    view, a point over Pierre's hover `+` button, and — twice — coordinates
    measured before something reflowed. **Re-measure after anything that
    reflows**, including posting a comment, which inserts an annotation row and
    moves every y below it.
  - `ShadowRoot.elementFromPoint()` will return *another* file's
    `diffs-container` host, whose root is the document. Require
    `sr.contains(el)`.
  - **Pierre binds pointer events, not mouse events** (`InteractionManager`:
    `pointerdown`/`pointermove`/`pointerup`). Browsers don't synthesize pointer
    events from a dispatched `MouseEvent`, so hand-dispatched drags must send
    `PointerEvent`s alongside the mouse ones or Pierre sees nothing at all.
  - **Hover-staleness bugs can't be reproduced synthetically.** Playwright's
    `mouse.click`/`dblclick` always emit a move first, which re-fires
    `onLineEnter` and heals the stale hover before mouseup; raw `down/up/down/up`
    with no move never reaches `detail: 2` in WebKit. Verify that class of bug
    from the other end — assert the value that *should* be authoritative —
    rather than burning a day on a repro.
  - **The state file is keyed by worktree+branch**, so two test servers in one
    checkout share it, including per-file collapsed state, which changes the
    layout under the next run. Delete it between runs.
  - Done reviewing needs a listener: attach `krit wait-for-submit` (background
    it properly — it blocks) or an agent WS subscriber, or it renders as a
    disabled "No watcher". It does not need any comments.
  - Playwright needs `PLAYWRIGHT_BROWSERS_PATH` somewhere writable, and
    launching the browser needs the sandbox off (XPC fails "Connection
    Invalid" otherwise).
- **The fs-watcher needs `com.apple.FSEvents` in the sandbox's
  `allowMachLookup`**: without it `FSEventStreamStart` fails silently, so
  `cargo test watcher` fails and a sandboxed `krit` never emits
  `files-changed`. The tell is the asymmetry — saves through the UI still
  work, because `PUT /api/file-content` broadcasts `file-written` directly
  and never consults the watcher. Working saves plus dead live-refresh means
  the sandbox, not the watcher. (The global sandbox config now grants it; the
  note stays because the failure is silent and the diagnosis is not obvious.)
- **Nothing can deliver input into the HTML preview's iframe.** It is
  `sandbox="allow-scripts"` with no `allow-same-origin`, so it is a separate,
  opaque origin and usually a separate process. Chrome DevTools-protocol input
  aimed at the page never arrives: a synthetic drag, a click and a keystroke
  all did nothing, and the tell that it is the harness rather than krit is that
  the *artifact's own* click handlers stay dead too, while the bridge's
  `postMessage`s keep arriving tagged `fromFrame`. Clicking does focus the
  `<iframe>` element, which makes it look like the event landed. Don't spend
  time on it — `htmlSandbox.test.ts` executes `BRIDGE_SCRIPT` against a
  document instead, which covers everything except the browser's own selection
  geometry.
- **Never `confirm()` / `alert()` for a decision.** A native dialog blocks the
  page for anything driving the browser programmatically, which is what krit
  is for — an agent that hits one deadlocks. This covers plain `alert()` on a
  failure path too: a frozen page is a frozen page, and a failure is exactly
  when nobody is watching. Everything routes through inline strips — the file
  header's save-anyway question, `FileEditorModal`'s discard, `CommentForm`'s
  discard-the-rewrite question, the save-conflict bars and the error strips in
  `.strip-stack`; keep it that way. No `confirm`/`alert`/`prompt` call remains
  anywhere under `src/ui`, and `nativeDialogs.test.tsx` globs the whole tree to
  keep it that way — a new one fails the build without anyone maintaining a
  list. Every exit from a form with unsaved work goes through one function
  (`requestClose`, `requestCancel`) so a new exit path can't skip the question.

## Non-obvious behavior (deliberate, don't "fix")

- The agent WebSocket (`/api/events-ws`) filters out `files-changed` (the
  fs-watcher's batched change event) and `file-changed` (a single direct
  edit/undo), comment-reanchor fallout, and the agent's own reply echoes —
  agents pay tokens per frame and shouldn't hear themselves work (`server.rs`,
  `agent_visible`). The UI's SSE stream (`/api/events`) carries everything.
  If a WS test "sees no events", check this before debugging the watcher.
- **The comment poll sets `refetchIntervalInBackground: true`** (`useComments`),
  overriding react-query's default of pausing an interval while the page is
  unfocused. An automated browser reports itself hidden the whole time it is
  driving krit, so the default freezes the comment list at whatever it held on
  load — no error, no stale badge, just a list that stops being true. The tell
  is again an asymmetry: `krit refresh` and every other SSE-driven update keep
  working, because only the poll consults focus. A hidden tab also freezes
  `requestAnimationFrame`, which is why `attachEditors` forces a synchronous
  render rather than waiting for a frame — when something updates for a human
  and not for an agent, suspect the tab's visibility before the feature.
- **Pierre's custom renderers are light DOM, projected by `slot`.** `SlotPortals`
  React-portals every `render*` callback's output into `renderedItem.element`
  with a `slot="…"` attribute, and the shadow root's `<slot>` elements pull it
  in — so `global.css` styles annotations and header prefixes normally, and
  `document.getSelection()` inside one returns real light-DOM nodes with no
  retargeting. The stale comment in `CommentForm` about being "portaled into
  the shadow root" is what makes this look harder than it is.
- **A file-level annotation (`lineNumber: 0`) is how the rendered preview
  replaces a diff**, and three things have to line up or it silently renders
  nothing:
  - `collapsed: true` suppresses annotations along with the rows, so it cannot
    be used to hide the diff. Hand CodeView a hunk-less copy of the fileDiff
    instead (`emptyDiffFor`) — empty body, item still expanded.
  - `AnnotationEventGuard` stops mouse/pointer events at the React root, which
    also stops the document-level `mouseup` a text selection needs. The
    preview pane is deliberately not wrapped in it; with no rendered rows
    there is no line interaction left to guard.
  - Pierre's virtualizer puts a `transform` on the row containers, which makes
    them the containing block for `position: fixed`. Anything fixed inside an
    annotation (the selection pill) must be portaled to `<body>` or it lands
    at an offset.
- **`remark-rehype` does preserve source positions** on the hast tree, despite
  a lot of advice to the contrary — including on inline nodes. That is what
  makes character-level anchoring on the Markdown preview exact rather than
  fuzzy, and it is why `rehypeSourceOffsets` is ten lines instead of a parser.
  What remark-rehype does *not* do is emit `data-sourcepos`; stamping that is
  ours. Don't "fix" the plugin away.
- **The HTML preview's two halves must agree on what counts as visible text**,
  and nothing catches it if they don't: the iframe reports an offset into a
  string the parent never sees, and the parent resolves it against a string it
  built by scanning the source. A disagreement is a silently wrong anchor, not
  an error. Both traps found so far shift *every* offset in the document —
  `<!DOCTYPE html>` scanned as text, and the newline between `</head>` and
  `<body>` that the parser drops but a naive scan keeps. `visibleTextOffsetOf`
  is serialised into the bridge with `toString()` so there is only one copy of
  the traversal, and `htmlSandbox.test.ts` asserts the two halves agree on
  every text run in a sample document. Keep that test honest if you touch
  either side.
- The launch message says "Asked the krit app to open" because `open::that`
  Ok only means the OS accepted the URL; a 10s post-launch check reports if
  no UI actually connected.

## Known gaps

- `@pierre/diffs` is pinned to an exact **prerelease** (`1.3.0-rc.1`), not a
  caret range: inline editing needs 1.3.0-only APIs (`item.edit`,
  `onItemEditComplete`, `EditProvider`, the `./edit` entry point). Because
  `dist/` is gitignored and `build.rs` runs vite, a from-source build of the
  Rust binary needs that exact version to still be on the registry — move to
  1.3.0 final once it publishes. An exact pin has no caret for `pnpm update`
  to follow, so nothing will prompt you.

- **Do not move the pin to `1.3.0-rc.2` or `-rc.3`: both break inline
  editing.** Clicking Edit throws ``ShikiError: Theme `github-light` not
  found`` from the page and the editor never attaches — the `contenteditable`
  host never appears, so the file is stuck in a session that can't take input.
  rc.2 introduced it and rc.3 carries it; rc.1 is clean on the same tree. The
  cause is visible in the published diff: rc.2 moved the force-token-transformer
  behaviour out of CodeView's option prototypes into the renderers'
  `beginEditSession()`, which renders an edit session **locally** with the
  worker pool suspended. The local highlighter never had krit's themes
  registered — only the pool's did — and the `hasResolvedThemes` guard added
  alongside it doesn't cover this path. Not a theme-shape problem on our side:
  collapsing `theme: {dark, light}` + `themeType: 'system'` to a single
  `'github-light'` string fails identically. Nothing to fix here; it needs an
  upstream fix, and the whole rest of the rc.1→rc.3 diff is safe for us (no API
  krit calls changed, and the selection path is byte-identical in WebKit).

- `@pierre/theming@1.0.0` declares a peer of `@pierre/theme: ^1.1.0` but the
  tree resolves `@pierre/theme@2.0.0` — an unsatisfied peer inside upstream's
  own dependency graph, not ours. Installs fine (optional peer,
  `strict-peer-dependencies` off). Nothing to do; don't "fix" it by pinning.

- Pierre resolves selection at **line** granularity only — `SelectionPoint` is
  `{lineNumber, side}`, and upstream never touches the DOM Selection API or
  caret-from-point (its one `getSelection` is `InteractionManager`'s own
  line-range tracker). Every character column krit persists comes from
  `selectionMapping.ts` doing that work itself. Don't go looking upstream for
  an API to switch to; there isn't one yet.

- An **inline edit session plus an open comment/suggest draft on the same
  file** is untested. Both render into Pierre's shadow root, historically
  where the WebKit trouble was.

- Comment/suggest **drafts don't survive a page reload** (persistence is the
  planned "Stage 8" in docs/design/live-review.md). Warn before advising a
  refresh mid-review.
- Nothing here publishes to npm. `diffx-cli` on npm is wong2's package,
  not ours.
