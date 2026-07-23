# krit — agent notes

Two implementations, one contract: `krit/` is the Rust server (primary);
`src/` is the v1 TypeScript CLI (`diffx-cli`, published to npm as fallback).
They share `src/ui/` (React, Pierre CodeView) and the HTTP/WS API — don't
break v1 wire compatibility without treating it as a breaking change.
`desktop/` is the Tauri app that claims the `diffx://` scheme.

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
- The desktop app and deep link stay `diffx`-branded: the app claims
  `diffx://` and a `krit://` identity would be an app-side change. Open
  decision, not an oversight.
- The launch message says "Asked the diffx app to open" because `open::that`
  Ok only means the OS accepted the URL; a 10s post-launch check reports if
  no UI actually connected.

## Known gaps

- Comment/suggest **drafts don't survive a page reload** (persistence is the
  planned "Stage 8" in docs/design/live-review.md). Warn before advising a
  refresh mid-review.
- npm publishing of `diffx-cli` uses OIDC trusted publishing; the
  npmjs.com trusted-publisher config must point at `kmosher/krit`
  (it was originally registered for `kmosher/diffx`). Until repointed,
  v1 releases will fail. Delete this note once fixed.
