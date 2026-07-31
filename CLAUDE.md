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
    layout under the next run. Delete it between runs. It carries **comments**
    too, so a server started for a "clean" run can come up holding an earlier
    run's set — and a diff rendered for six anchors you forgot about looks
    nothing like one rendered for the one anchor you just added.
  - **Three ways to misread what rendered**, each of which yields a confident
    wrong answer rather than an error. `shadowRoot.textContent` does not
    contain annotations — they are slotted light DOM (see the `SlotPortals`
    note below), so a comment can be on screen and absent from that string.
    Rows and hunk separators are **virtualized**, so any count, or any "is this
    still collapsed" check, is really a question about where the surface
    happens to be scrolled. And a scroll loop is only as good as its scroller:
    `.diff-viewer` is not it, and driving the wrong element silently measures
    one screen N times. When the question is "what layout did this produce",
    add a `console.log` to the code and read it, or take a screenshot — do not
    interrogate the DOM from the outside.
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
- **Drive `krit-tui` under tmux, not under a hand-rolled pty.** tmux is a
  debugged terminal emulator that will hand you the rendered screen, which is
  the whole problem (see below). It needs the sandbox off — `openpty` fails
  "Operation not permitted" — and its own server and config, so a run never
  touches the session you are sitting in:

  ```
  tmux -L krittest -f /dev/null new-session -d -s t -x 120 -y 40 "…krit-tui …"
  tmux -L krittest capture-pane -p -t t     # the screen, as text
  tmux -L krittest send-keys -t t f         # a key
  tmux -L krittest send-keys -t t -H 1b 5b 3c 36 35 3b 36 30 3b 31 30 4d
  tmux -L krittest kill-server
  ```

  That `-H` line is a wheel-down: mouse input goes in as an SGR report,
  `ESC[<{button};{col+1};{row+1}M` to press and `m` to release, button 64/65
  for wheel up/down. crossterm parses those whether or not capture is on, so a
  test can drive the mouse without the terminal cooperating.
  - **Why not read the pty yourself: a captured chunk is a delta, not the
    screen.** ratatui emits only the cells that changed, so the bytes arriving
    after an event show an unchanged screen as an empty one — indistinguishable
    from the feature being broken. Stripping escapes and splitting on newlines
    is no better, because ratatui positions every run with `CUP` and emits
    almost no newlines: you get a few very long lines, not rows. Writing a
    small emulator instead works, but it is a real terminal's job and a
    from-scratch one has from-scratch bugs (a `CUP` handler comparing a bytes
    match group against a str, silently collapsing every row onto row 0). Five
    confident "failures" in one session came out of this, none of them a bug in
    krit. If you must read a pty directly, `TIOCSWINSZ` it first — a pty
    inherits no size, and a 0×0 terminal makes the app faithfully draw nothing
    — and replay the whole byte stream rather than feeding chunks, since a read
    splits escape sequences at 1 KiB.
  - Suspend has to be verified from outside: `ps -o state=` shows `T` while
    stopped, and the app must have emitted `ESC[?1049l` *before* it stopped.
    tmux is the wrong tool for that one — it owns the process group — so
    suspend stays a hand-rolled `pty.fork`.
  - For a committed harness (nobody has written one yet), the Rust equivalents
    are `portable-pty` to spawn and `vt100` to model the screen, with `insta`
    for the snapshots. Untried here.
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
- **`krit-tui` starts a server when there isn't one, and never stops it.**
  Killing it on exit would be wrong whenever a browser tab is also attached,
  and unnecessary either way: the idle timeout already counts subscribers, so
  a server nobody is watching goes away on its own. The adopt path probes
  `/api/settings` before trusting the state file — a crashed server leaves one
  behind, and believing it means reporting "cannot reach krit" when the honest
  answer is that we should have started one. A server that *is* running keeps
  its own diff range; `-- <args>` passed to a viewer that adopts one is
  reported in the status strip rather than silently ignored.
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
- **`scrollRef.current` is CodeView's element, and CodeView is keyed by
  `structuralRevision`** — so every listener or observer bound to it must have
  `structuralRevision` in its deps. A change to the *file set* (an agent adding
  or dropping a file) remounts the view and hands the ref a new node; anything
  bound once keeps working against the detached one, with no error and nothing
  else visibly wrong. That is how the selection pill died mid-session: drags
  stopped producing a pill while hover, comments and scrolling all still worked.
- **An open draft is anchored by element, not by scrollTop.** Restoring a
  numeric scroll position across a diff update preserves the number and loses
  the place: a write to any file above the viewport changes its height and
  walks the comment form off the screen mid-sentence. `captureDraftAnchor` /
  `holdDraftAnchor` note where the form sits and put it back, re-finding it by
  `data-draft-key` (a remount rebuilds the node) over a bounded loop of ticks —
  one correction is not enough, since the worker pool, Pierre's relayout and
  Pierre's own scroll reanchoring each move things again afterwards. Every
  property of that loop below is load-bearing, and each fails silently — a green
  suite and a clean build say nothing about any of them:
  - **Nothing in this loop may hang off `requestAnimationFrame`.** A page
    reports itself hidden the whole time anything drives it programmatically,
    and a hidden page's rAF callbacks never run — so an rAF-driven hold is a
    no-op in exactly the sessions krit exists for, with nothing to see but a
    draft that scrolled away. It ticks on a `setInterval` plus a
    `ResizeObserver`, both of which survive being hidden.
  - **A scroll the loop did not perform is not evidence of a human.** Pierre
    reanchors scroll itself after a relayout, so backing off on an unexpected
    `scrollTop` means backing off exactly when the correction is needed. Real
    input events (`wheel`, `pointerdown`, `keydown`, `touchstart`) are the
    signal that the reviewer has taken over — **except the ones coming out of
    the draft itself**. The form is a descendant of the container those
    listeners sit on, and `AnnotationEventGuard` cannot stop them: it stops
    React's synthetic events at the React root, which the native event reaches
    only after bubbling past the container. Unfiltered, typing cancels the hold
    that exists for typing.
  - **The container the hold is bound to can be replaced under it.** The
    structural path starts a hold *before* the remount, so the node bound at
    that moment is detached a tick later — a loop nothing can release, on the
    update that moves the most layout. Every tick re-checks the identity
    (`bindAnchorHold`), and teardown removes listeners from what it bound to,
    not from whatever is current.
  - **The form is not always in the DOM to measure.** A big enough update
    pushes the draft's file out of Pierre's virtual window mid-correction and
    unmounts the form, and no scrollTop arithmetic can get it back — only
    Pierre knows where an unrendered line is. That is why the anchor carries
    the draft's *line* as well as its key, and recovers with `scrollTo` before
    fine-positioning. Watching only the element, the loop chases the layout
    down the page and parks the reviewer inside the file that grew.
  - **Match the key by scanning `dataset`, never with an attribute selector.**
    `draftKey` joins with NUL and `CSS.escape` maps NUL to U+FFFD, so an
    escaped key cannot match the attribute React set. The lookup then returns
    null on every frame and the whole feature is a silent no-op — no error, and
    nothing a unit test can see.
- **A draft's "the reviewer edited the rewrite" bit is stored, not derived**
  (`suggestionEdited`, carried on the draft and across the wire). The obvious
  implementation compares the editor text against the file's current lines, and
  that comparison is wrong in both directions the moment an agent writes the
  file under an open form: an untouched draft reports as edited (a discard
  prompt for a rewrite nobody wrote, and worse, a *posted* suggestion carrying
  pre-write content, which applied reverts the agent), and a typed one reports
  as untouched if the file happens to catch up to it (silently dropped). One
  derived value, `suggestionChanged`, answers it for every path — post, submit-
  enabled, and discard — because a disagreement between those is invisible.
  Absent on a draft stored before the field existed, it falls back to the
  comparison: over-asking is recoverable, dropping typed work is not.
- **Pierre's custom renderers are light DOM, projected by `slot`.** `SlotPortals`
  React-portals every `render*` callback's output into `renderedItem.element`
  with a `slot="…"` attribute, and the shadow root's `<slot>` elements pull it
  in — so `global.css` styles annotations and header prefixes normally, and
  `document.getSelection()` inside one returns real light-DOM nodes with no
  retargeting. The stale comment in `CommentForm` about being "portaled into
  the shadow root" is what makes this look harder than it is.
- **A preview renderer's entire contract is `data-src`.** Every element it
  emits carries `"<startOffset>-<endOffset>"` into the *file*, and
  `previewAnchor.ts` needs nothing else — which is why Markdown, `.ipynb` and
  `.csv` share one selection path, one highlight path and one comment path.
  Adding a format is a renderer plus an entry in `previewFormatFor`; anything
  that reaches for a second mechanism has taken a wrong turn.
  - **A notebook is the one format where a rendered offset is not a file
    offset.** Cell text lives in JSON string literals, and an escape is more
    source characters than decoded ones, so `jsonPositions.ts` keeps a
    per-character map and the notebook path composes it into the stamps
    (`mapOffset` on `rehypeSourceOffsets`). Skip the map and every anchor is
    quietly off by however many escapes precede it, which reads as a plausible
    anchor, not an error.
  - **Stamp a code cell per line, not per cell.** `previewAnchor` locates a
    position by searching the element's source slice for the text node's exact
    value: one line does occur verbatim inside its own literal, while a whole
    cell — real newlines where the file has `\n",\n "` — does not, and every
    selection in it would widen to the cell.
  - **Outputs carry no stamp on purpose.** There is no source position behind a
    rendered figure, and an unstamped subtree yields no anchor rather than a
    wrong one. `text/html` outputs are dropped entirely: the pane renders in
    the page, and that markup is kernel-authored.
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
- **A comment anchored in a collapsed unchanged region renders nothing at
  all** — no marker, no gutter hint — because Pierre draws annotations only
  for lines it rendered. `handlePostRender` therefore calls `revealLine` for
  every anchored line as each file renders, which is why the reveal hangs off
  the render pass and not off an item write: virtualization rebuilds a file
  from scratch and the expansion state lives on the instance. Two consequences
  worth knowing. Every reveal queues another render pass, so the loop is
  bounded (`MAX_REVEAL_PASSES`); without that, an expansion that failed to make
  its line renderable would hang the tab. And `revealLine` is keyed on new-file
  lines, so a deletion-side anchor goes through `additionLineForAnchor` first.
  Reveal is now only the fallback for short gaps — see the next note.
- **A long gap gets an invented hunk, not an expansion** (`commentIslands.ts`,
  spliced in `App.tsx` between `files` and what DiffViewer renders). Upstream
  can only open a gap from its two edges — `HunkExpansionRegion` is
  `{fromStart, fromEnd}` and there is no third window — so revealing a line
  mid-gap renders everything between it and the nearer hunk. A *hunk's* lines
  always render, so krit splits the gap instead: a context-only hunk around the
  anchor, collapsed regions still on both sides. One comment in a 286-line gap
  costs 31 rendered rows this way against ~243 for a reveal.
  - It is safe to invent because it claims nothing: `additionLines` and
    `deletionLines` are 0, so the island only re-labels lines the gap already
    held. It consumes exactly what it removes from the next hunk's
    `collapsedBefore`, which is why no later hunk's `splitLineStart` or
    `unifiedLineStart` moves and the file's totals still hold. Nothing upstream
    promises that, so `commentIslands.test.ts` asserts it against real
    `parseDiffFromFile` output — and asserts it on upstream's own hunks first,
    so a failure says which side moved.
  - The anchor set is read off the **un-islanded** diff. Read it back off the
    result and every anchor is inside a hunk, the islands drop, and the next
    pass strands them again.
  - **Reveal and islanding must agree on who owns a line** (`islandOwnsLine`),
    because a Pierre expansion is permanent on the instance. A comment arriving
    mid-session updates the item's annotations before the islanded `fileDiff`
    reaches it, so an unguarded reveal wins that race, expands from the hunk
    edge, and nothing can take it back — the session then drifts steadily away
    from the layout a reload produces, which is what makes this look like a
    Pierre bug rather than ours.
  - An island needs the gap's old/new offset (`deletionStart`), or split view
    renders the wrong text in the left column. Unit tests cover the arithmetic;
    it is worth re-checking in a browser on a diff whose line numbers actually
    diverge, since a zero offset hides the bug.
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
- **Done reviewing closes krit.app's window, and cannot close a browser tab.**
  `window.close()` only works on a window a script opened, and a tab launched
  from a terminal has no opener — Chrome ignores the call. So the button says
  "Done ✓ — close this window" when the window is staying, and `closeReviewWindow`
  returns which happened rather than pretending. krit.app closes for real
  through Tauri's own API (`withGlobalTauri`, plus `core:window:allow-close`
  scoped to the localhost URLs the app frames). Do not reach for the
  `window.open('', '_self')` trick: in Chrome it navigates the review away and
  still leaves the tab.
  - **Await the app's `close()` and treat a rejection as "stays open".** The app
    bundle and the UI ship separately (`cargo tauri build` vs `cargo install`),
    so an installed app whose capabilities predate the UI denies the call from a
    `close` that exists and looks callable. Swallowing that rejection puts back
    exactly the dead frame the capability was added to prevent, and the label
    would say the review is done.
  - The capability's remote scope is loopback-wide, which is not an identity —
    so the window itself is pinned to the origin it was opened with
    (`on_navigation` in `desktop/src-tauri/src/main.rs`). A review renders
    Markdown from the branch under review, and the links in it are the branch
    author's to choose.
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
- **Only a queued comment is editable**, and its "Queued" badge is the button
  that opens the editor (`QueuedCommentEditor`). The restriction is not caution
  about the UI: `PUT /api/comments/{id}` broadcasts nothing for a body change —
  the only broadcast on that route is the catch-up `comment-added` when a queued
  comment is posted — so editing an already-posted comment would leave the
  reviewer and the agent reading different text with nothing anywhere to say so.
  Making open comments editable means giving that route a `comment-updated`
  broadcast first, and teaching the agent side what to do with it. (Note
  `comment-updated` is filtered out of the agent stream today, so that is two
  changes, not one.)
  - The reviewer can lose a race they cannot see: "Post queued" and Done
    reviewing both flip the status while a save is in flight. Three things hold
    the line, and the first two are not enough alone — **the write carries
    `expectStatus: "queued"`** and the server refuses it with a 409 once the
    comment has been posted; **the posting paths wait** for in-flight saves
    (`settleEdits`); and **the editor keeps the reviewer's text on screen** when
    a save is refused, because at that point it exists nowhere else.
  - The bubble is **keyed by comment id** at every call site, and resets its own
    editing state when the id changes. Pierre keys line annotations by array
    *index*, so deleting a comment earlier in a file shifts every later one into
    its neighbour's slot — React then reuses the component, and an open editor
    would file one comment's text under another comment's id.
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
