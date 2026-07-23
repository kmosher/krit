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
- Fresh worktrees have no `dist/` — build.rs handles it, but the vite build
  needs `node_modules` (symlink from canonical or `pnpm install`).

## Non-obvious behavior (deliberate, don't "fix")

- The agent WebSocket (`/api/events-ws`) filters out `file-changed`,
  comment-reanchor fallout, and the agent's own reply echoes — agents pay
  tokens per frame and shouldn't hear themselves work (`server.rs`,
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
