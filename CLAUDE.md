# krit — agent notes

`krit/` is the Rust server; `src/ui/` (React, Pierre CodeView) is the web
UI it embeds; `src/types.ts` is the comment schema both share. `desktop/`
is the Tauri app (krit.app) that claims the `krit://` scheme. The HTTP/WS
API descends from v1 diffx (wong2's, later this repo's TS CLI — removed
2026-07) — treat wire-contract changes as breaking, external consumers
exist.

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
- **The fs-watcher is dead under Claude Code's Bash sandbox**: FSEvents
  delivers nothing, so `cargo test watcher` fails and a sandboxed `krit`
  never emits `files-changed`. Anything exercising live refresh — including
  a server you intend to drive from a browser — has to run with the sandbox
  disabled. Explicit saves (`PUT /api/file-content`) broadcast
  `file-written` directly and work either way, which is what makes this look
  like a product bug instead of an environment one.

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

- Comment/suggest **drafts don't survive a page reload** (persistence is the
  planned "Stage 8" in docs/design/live-review.md). Warn before advising a
  refresh mid-review.
- Nothing here publishes to npm. `diffx-cli` on npm is wong2's package,
  not ours.
