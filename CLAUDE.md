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

- `@pierre/theming@1.0.0` declares a peer of `@pierre/theme: ^1.1.0` but the
  tree resolves `@pierre/theme@2.0.0` — an unsatisfied peer inside upstream's
  own dependency graph, not ours. Installs fine (optional peer,
  `strict-peer-dependencies` off). Nothing to do; don't "fix" it by pinning.

- An **inline edit session plus an open comment/suggest draft on the same
  file** is untested. Both render into Pierre's shadow root, historically
  where the WebKit trouble was.

- Comment/suggest **drafts don't survive a page reload** (persistence is the
  planned "Stage 8" in docs/design/live-review.md). Warn before advising a
  refresh mid-review.
- Nothing here publishes to npm. `diffx-cli` on npm is wong2's package,
  not ours.
