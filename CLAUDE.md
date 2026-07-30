# krit — agent notes

A cargo workspace plus a web UI. `krit/` is the Rust server; `src/ui/`
(React, Pierre CodeView) is the web UI it embeds; `krit-tui/` is a second,
terminal client (ratatui — read-only so far, see `docs/design/tui.md`);
`krit-core/` holds what the server and its Rust clients must agree on
exactly — the wire types, state-file discovery, repo identity, and
`diff_header_path`. `src/types.ts` mirrors `krit-core::types` for the web UI
and is the copy that can still drift. `desktop/` is the Tauri app (krit.app)
that claims the `krit://` scheme.

The HTTP/WS API descends from v1 diffx (wong2's, later this repo's TS CLI —
removed 2026-07), which is why some shapes look the way they do; it is not a
constraint. Change the wire freely, and move the server, both clients and the
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
  - `waitUntil: 'networkidle'` never fires: the comment poll and the SSE stream
    keep a request in flight for the life of the page. Wait on
    `domcontentloaded` and then on a selector.
  - Raise `--idle-timeout`. The default 5s window exists to survive a refresh,
    which is shorter than the gap between two Playwright runs — the server
    exits between them and the next run's first `goto` reports a bare
    connection failure.
  - **A page load is not a mount of the whole app** — but Pierre still needs a
    beat: annotations attach after the highlight worker pool settles, so a form
    hydrated from `/api/pending-drafts` is not in the DOM the instant
    `diffs-container` is.
  - Pierre's hover `+` does not appear from `page.mouse.move` alone. When the
    thing under test is reachable another way — seeding server state and letting
    the UI restore it, say — take that route rather than making the run depend
    on the hover affordance.
  - Done reviewing needs a listener: attach `krit wait-for-submit` (background
    it properly — it blocks) or an agent WS subscriber, or it renders as a
    disabled "No watcher". It does not need any comments.
  - Playwright needs `PLAYWRIGHT_BROWSERS_PATH` somewhere writable, and
    launching the browser needs the sandbox off (XPC fails "Connection
    Invalid" otherwise).
- **Driving `krit-tui` needs a pty with a size, and the sandbox off.**
  `openpty` fails "Operation not permitted" under the Bash sandbox. And a pty
  inherits no window size, so `script`-style harnesses hand the app a 0×0
  terminal and it faithfully draws nothing: fork the pty yourself and
  `TIOCSWINSZ` it before reading a byte.
  - **A captured chunk is a delta, not the screen.** ratatui emits only the
    cells that changed, so reading the bytes that arrive after an event shows
    an unchanged screen as an empty one — which reads exactly like the feature
    being broken. Two checks were confidently wrong this way before the cause
    was obvious. Force a full repaint before capturing (nudging the window size
    makes `Terminal::draw` autoresize and repaint everything), or keep a real
    emulator's screen state.
  - Suspend has to be verified from outside: `ps -o state=` shows `T` while
    stopped, and the app must have emitted `ESC[?1049l` *before* it stopped.
- **The fs-watcher needs `com.apple.FSEvents` in the sandbox's
  `allowMachLookup`**: without it `FSEventStreamStart` fails silently, so
  `cargo test watcher` fails and a sandboxed `krit` never emits
  `files-changed`. The tell is the asymmetry — saves through the UI still
  work, because `PUT /api/file-content` broadcasts `file-written` directly
  and never consults the watcher. Working saves plus dead live-refresh means
  the sandbox, not the watcher. (The global sandbox config now grants it; the
  note stays because the failure is silent and the diagnosis is not obvious.)
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
- **`krit-tui` subscribes as `role=ui`, not `role=cli`.** It is a human's
  client, so it has to hold the server open the way a browser tab does; a `cli`
  subscription would let the idle timeout fire with the review still on screen.
  The visible consequence is that a running TUI counts in `clients.browsers`,
  which is correct — it is a UI — but means "browsers: 1" no longer implies a
  browser. The other half of the same choice: `/api/events` is unfiltered on
  purpose, so the TUI debounces its refetches itself rather than asking the
  server to coalesce.
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
- The launch message says "Asked the krit app to open" because the launcher
  returning Ok only means the OS accepted the URL; a 10s post-launch check
  reports if no UI actually connected.
- **Launch `krit` itself with the sandbox off** (`dangerouslyDisableSandbox:
  true`), as the krit skill says. The `krit://` deep link — and the browser
  tab, in the other launcher mode — is opened by a *spawned* `open`, and the
  Bash sandbox blocks that child even though `krit` runs fine. Nothing in the
  settings can fix it from krit's side: the `open *` exclusion matches the
  command *text* of a Bash call, so it never applies to a process krit forks.
  The result is a server with no window. `spawn_deep_link` goes through
  `/usr/bin/open` directly rather than `open::that` so the launcher's stderr
  survives into the error — that is what tells a denial (`procNotFound`) apart
  from a missing app, which an exit status alone cannot.

## Known gaps

- `@pierre/diffs` is pinned to an exact **prerelease** (`1.3.0-rc.3`), not a
  caret range: inline editing needs 1.3.0-only APIs (`item.edit`,
  `onItemEditComplete`, `EditProvider`, the `./edit` entry point). Because
  `dist/` is gitignored and `build.rs` runs vite, a from-source build of the
  Rust binary needs that exact version to still be on the registry — move to
  1.3.0 final once it publishes. An exact pin has no caret for `pnpm update`
  to follow, so nothing will prompt you.

- **The theme that reaches the worker pool is the one that paints. Set a theme
  in both places or neither.** The pool renders every surface that isn't in an
  edit session, and it is configured by `highlighterOptions` on
  `WorkerPoolContextProvider` (`main.tsx`) — *not* by the `theme` option on the
  view. krit passes the pool no theme, so everything renders in Pierre's own
  `pierre-dark`/`pierre-light`. A `theme` named on the CodeView options alone
  reaches only the editor's tokenizer, so the two disagree, and from
  `1.3.0-rc.2` that disagreement is fatal: the tokenizer's constructor calls
  `setTheme` for a theme the shared highlighter never attached, throws
  ``Theme not found``, and — because the throw lands before the content element
  is made `contentEditable` — the file enters an edit session with no editable
  element at all. The only symptom is an unhandled rejection. krit therefore
  names no theme on either side; that is why `CodeViewWrapper`'s options carry
  `themeType` but no `theme`. Upstream fix (attach both themes) is filed from
  `kmosher/pierre`, branch `kmosher/shiki-fix`; once it ships, naming a theme in
  both places becomes safe. rc.1 tolerated the mismatch because
  `initializeHighlighter` read the instance options instead of the pool's.

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

- **"Draft" and "queued" are two different things**, and both were once called
  "draft". A comment with `status: "queued"` *is* a comment — stored, listable,
  withheld from the agent until posted. A `PendingDraft` is text the reviewer
  has not submitted at all, persisted through `/api/pending-drafts` so it
  survives a reload or a closed TUI pane. "Draft" now means only the second.
  Store files written before the rename say `"draft"` for the first;
  `store::load` migrates them, and that migration is the only thing keeping a
  queued comment from leaking — every suppression check is `== "queued"`, which
  a stale `"draft"` would satisfy nowhere.
- Pending drafts are the one mutation that **deliberately does not broadcast**.
  Echoing a reviewer's keystrokes back into the form they came from fights the
  form, and unsent text is not the agent's business — so there is no SSE event
  and nothing for `agent_visible` to filter. Hydrate on load, write on change.
  Two clients editing the same slot is therefore last-writer-wins, not merged.
- **A reload is not an unmount**, so `usePendingDrafts` flushes its debounce on
  `pagehide` as well as on effect cleanup. React cleanup runs when a component
  leaves a live tree, not when the document is torn down — an unmount-only flush
  silently loses the last <400ms of typing before exactly the reload the feature
  exists to survive, and no unit test can see it because there is no document to
  tear down. The unload write needs `keepalive: true` or it is cancelled with
  the page. Not `visibilitychange`: an automated browser reports itself hidden
  for its whole run (see the comment-poll note above), so hidden means nothing.
- `updateDraft` in `CodeViewWrapper` mutates the draft object **in place** and
  never calls `setPending` — a state update there rebuilds the file's whole
  annotation DOM on every keystroke. That means there is no state transition an
  effect can watch, which is why persistence hangs off `updateDraft` itself and
  why `usePendingDrafts.persist` snapshots the fields instead of holding the
  reference.
- Nothing here publishes to npm. `diffx-cli` on npm is wong2's package,
  not ours.
