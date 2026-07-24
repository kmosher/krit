# Reactive-loop performance: coalesced change events end-to-end

Status: spec / in progress (branch `kmosher/perf-reactive-loop`)

## Problem

krit's live-refresh loop amplifies a single burst of file changes into
`O(files × open-tabs)` full-repo git diffs and a whole-review re-parse on the
client for **every** file. Measured/traced at HEAD `b8020f9`:

- The fs-watcher fires `on_change(path)` **per changed file** → each broadcasts
  its own `file-changed {path}` SSE frame.
- The UI's `useDiff` reacts to each frame with a *scoped* `GET /api/diff?file=`
  refetch — good that it's scoped, but the server still runs a **full-repo
  `git diff`** and re-forks `repo_name` + `branch` + `ls-files` on every one of
  them, then string-slices out the one file.
- Each refetch replaces the merged `patch` string → the client re-runs
  `parsePatchFiles` over the **entire** patch and `parseDiffFromFile` over
  **every** file, plus `CodeViewWrapper` `JSON.stringify`s every file's full
  contents to find which one changed.

A 1000-file checkout with 3 tabs open ≈ **3,000 whole-repo diffs, ~18,000 git
forks, 3,000 whole-review re-parses**. The correct DOM patch is one file; the
detection/compute cost is `O(total review size)` per event.

## Vision

Collapse the burst at the source and keep every downstream step file-scoped:

```
fs burst ─(200ms debounce, already there)─▶ watcher yields ONE Vec<path>
   │
   ├─ reanchor the changed files (batch; persist once)
   └─ broadcast ONE  files-changed {paths:[...]}   (replaces per-file frames)
        │  SSE /api/events
        ▼
   useDiff: ONE  GET /api/diff?files=a,b,c   (one git diff, cached repo/branch)
        │  splice each returned fragment into merged state
        ▼
   App: re-parse ONLY the changed files (per-file parse cache), not the patch
        ▼
   CodeViewWrapper: cheap per-file change detection (no whole-review stringify)
        ▼
   DOM: updateItem() for the changed files only  (already correct today)
```

Result: a burst of M files across U tabs → **U batch diffs** (one per tab), **M
per-file parses total** (not M×U×M), **1 SSE frame per tab**.

## Design decisions (locked)

1. **Wire contract — Replace, not additive.** The watcher path emits a single
   new event `files-changed {paths:[...]}` and **stops** emitting per-file
   `file-changed`. `file-changed` remains in the `Event` enum for any other
   caller but is no longer produced by the ambient watcher. (Owner decision:
   the agent WS already filters `file-changed` out, and the krit UI is the
   primary consumer, so the clean break is worth killing the per-frame fanout.)
2. **`files-changed` is agent-invisible**, exactly like `file-changed`:
   `agent_visible` must return `false` for it (agents pay per frame and must not
   hear file churn — see CLAUDE.md).
3. **Batch, don't stream.** A single change is just a 1-element `paths` array —
   there is no separate single-file event on the watcher path.
4. **Backward-compatible payload shape.** `GET /api/diff?files=…` returns the
   **same** `DiffData` JSON as `?file=`, only scoped to several paths. No new
   response schema.

## Wire contract (frozen — both sides code to this)

### SSE event (Rust `Event` enum, `#[serde(tag="type", rename_all="kebab-case")]`)

```jsonc
{ "type": "files-changed", "paths": ["src/a.rs", "src/b.rs"] }   // 1..N paths, repo-relative
```

Rust: `FilesChanged { paths: Vec<String> }`. TS (`src/types.ts` + `useDiff`):
`{ type: 'files-changed'; paths: string[] }`.

### HTTP endpoint

`GET /api/diff?staged=<bool>&untracked=<bool>&file=<p1>&file=<p2>&…`

- **Multiple `file=` params**, one per path (repeated query keys) — NOT a
  delimited list. Repo-relative paths can contain commas/newlines, so repeated
  keys avoid all delimiter escaping. A single `file=` is the existing
  1-path case, unchanged. The server collects **all** `file` values (switch the
  extractor from single `params.get("file")` to a repeated-key collector, e.g.
  `Query<Vec<(String,String)>>` filtered on key `"file"`).
- Returns the existing `DiffData` shape, but `patch` is the concatenation of
  just those files' fragments (in request order), and `binaryFiles` /
  `untrackedFiles` / `fileContents` only ever mention those paths.
- Empty fragment for a path with no pending diff (reverted between event and
  request), mirroring the current `?file=` semantics.
- Client builds the query as `file=<enc(p1)>&file=<enc(p2)>&…`.

## Work decomposition

Three tracks, **disjoint file sets**, implementable in parallel. Each track
owns its files exclusively; do not edit files outside your set; do not run
`git`; verify with the commands listed (no `vite build` — it writes `dist/`
which is shared).

### Track A — Backend (Rust only)

Files: `krit/src/types.rs`, `krit/src/watcher.rs`, `krit/src/main.rs`,
`krit/src/hub.rs`, `krit/src/server.rs`, `krit/src/git.rs`,
`krit/src/store.rs`, `krit/src/reanchor.rs`.

A1. **`types.rs`**: add `FilesChanged { paths: Vec<String> }` to `Event`.
    Add a serialization test asserting
    `{"type":"files-changed","paths":["a.rs"]}`.

A2. **Coalesce the watcher fanout.** Change `watcher::watch_repo`'s callback
    from `impl Fn(String)` to `impl Fn(Vec<String>)`: the debounce closure
    already builds the tick's deduped, filtered, actually-content-changed
    paths — collect them into a `Vec` and invoke the callback **once** per tick
    (skip if empty). Update `main.rs` to reanchor each changed path (see A4 for
    batched persist) and broadcast **one** `Event::FilesChanged { paths }`.
    The per-path `FileChanged` broadcast on this path goes away.

A3. **Stop re-forking + scope the diff.**
    - `server.rs` `agent_visible`: `Event::FilesChanged { .. } => false`.
    - `server.rs` `api_diff`: derive `repo_name` from `state.repo_root`
      (`.file_name()`), not `git::repo_name()` — no fork. Compute the untracked
      path list **once** and reuse it (kill the double `ls-files`).
    - Collect **all** repeated `file=` params (not one) and serve a
      **path-scoped** diff. Add `git::git_diff_paths(paths, …)` in `git.rs` that
      runs `git diff … -- <paths>` so we don't diff the whole repo then slice.
      A single `file=` routes through the same scoped path with a 1-element list.
    - Branch: recompute `branch_name` only on a **full** refetch (no `file`/
      `files` param), or cache behind a short TTL in `Inner` — never on the
      scoped hot path. (The watcher can't see `.git/HEAD`, so don't cache
      forever.)

A4. **Batch persist.** `store.rs`: add `update_many` (or a dirty-flag +
    `persist_now`) so a reanchor pass over C moved comments writes the file
    **once**, not C times. `reanchor.rs`: use it.

Verify: `KRIT_SKIP_UI_BUILD=1 cargo test`, `cargo clippy --release
--all-targets`, `cargo fmt --check`. Add/adjust tests for A1, A2 (batch
callback), A3 (`files=` scoping, repo_name-without-fork), A4 (single write).

### Track B — Frontend core render loop (TypeScript)

Files: `src/types.ts`, `src/ui/hooks/useDiff.ts`, `src/ui/hooks/useViewed.ts`,
`src/ui/App.tsx`, `src/ui/components/CodeViewWrapper.tsx`,
`src/ui/components/DiffViewer.tsx`.

B1. **Consume `files-changed`.** In `useDiff`'s SSE handler, handle
    `files-changed {paths}`: do **one** batch refetch
    `GET /api/diff?...&file=<enc(p1)>&file=<enc(p2)>&…` and splice every returned
    fragment into the merged state in a single `setData` (extend `spliceFilePatch`
    / `loadFile` to a `loadFiles(paths)` that applies all fragments at once). Respect `refreshMode` per path exactly
    as today (ultra/live/manual/live-unless-active); defer the deferred subset,
    apply the rest in one refetch. `file-written {path}` (single) and
    `path:null` (full reload) are unchanged.

B2. **Per-file parse cache (kill the whole-review re-parse).** Today `files`
    (`App.tsx:148`) re-runs `parsePatchFiles` + `parseDiffFromFile` over the
    entire review whenever `patch` identity changes. Restructure so parsing is
    **per file, memoized by that file's identity** — only files whose fragment
    or `fileContents[path]` entry actually changed get re-parsed; unchanged
    files keep their prior `FileDiffMetadata` object (stable identity). Fold the
    `diffStats`/`fileStatsMap` computation into the same per-file pass so the
    patch isn't walked a second time. `useDiff` already replaces `fileContents`
    per-file — thread that granularity through rather than deriving everything
    from one monolithic `patch` string.

B3. **Cheap change detection in `CodeViewWrapper`.** Replace the
    `fileContentSignature` that `JSON.stringify`s every file's full contents
    (`CodeViewWrapper.tsx:~352`) with a cheap per-file signal: compare the
    stable per-file `FileDiffMetadata` identity from B2 (or a small version
    number bumped only for changed files). `viewer.updateItem()` only the files
    whose identity changed. No whole-review serialization per event.

B4. **`useViewed` memo (one-liner, high impact).**
    `const viewedFiles = useMemo(() => new Set(viewedList), [viewedList])` so a
    stable viewed set stops breaking `DiffViewer`'s `memo` on every scroll.

Verify: `pnpm exec tsc --noEmit`, `pnpm exec eslint src/types.ts src/ui/hooks/useDiff.ts src/ui/hooks/useViewed.ts src/ui/App.tsx src/ui/components/CodeViewWrapper.tsx src/ui/components/DiffViewer.tsx`.
Do NOT run `vite build`. Preserve every "done right" behavior noted below.

### Track C — Frontend list virtualization (TypeScript)

Files: `src/ui/components/FileTree.tsx`, `src/ui/components/CommentTracker.tsx`.

C1. **`FileTree`**: wrap in `React.memo`; memoize the `TreeDir`/`TreeFile` row
    components; virtualize the row list so a several-thousand-file review
    doesn't repaint every row on each scroll-driven `activeFile` change. Keep
    the existing prop interface unchanged (App passes the same props).

C2. **`CommentTracker`**: `memo` the component; `useMemo` the sort + the four
    count passes into a single pass; virtualize the comment list. Keep the
    existing prop interface.

Use the virtualization approach already in the codebase if one exists (check
whether Pierre/CodeView exposes a virtualizer or a lib is already a dep before
adding a new dependency; prefer no new dep — a lightweight windowing helper is
fine). Read but do NOT edit `src/types.ts`.

Verify: `pnpm exec tsc --noEmit`, `pnpm exec eslint src/ui/components/FileTree.tsx src/ui/components/CommentTracker.tsx`.

## Do-not-break list (verified good today — preserve exactly)

- Comment typing is kept **off** React state (`CodeViewWrapper` drafts mutated
  in place) — no re-render per keystroke.
- The CodeMirror/Pierre instance is patched via `viewer.updateItem()`, never
  torn down per render/keystroke; `options` memo is stable.
- react-query structural sharing keeps `comments` referentially stable across
  the 3s poll — don't introduce a new object identity there.
- `DiffViewer` remounts on `staged:untracked:customMode` key change
  (intentional state reset) — keep it.
- `refreshMode` semantics (ultra / live / manual / live-unless-active) and the
  `staleFiles` badge/toast flow.

## Compatibility & risks

- **Wire break**: ambient `file-changed` disappears from `/api/events` (locked
  decision). `file-changed` stays in the enum; `file-written` and `path:null`
  full-reload semantics unchanged. The end-of-work review runs
  `kmosher-review:review-compatibility` to sanity-check nothing else consumed
  it.
- `agent_visible` MUST filter `files-changed` (A3) or agents start hearing file
  churn — a regression of the deliberate behavior in CLAUDE.md.
- Multi-scope uses **repeated `file=` query params** (locked above), so no
  delimiter-escaping problem for paths containing commas/newlines. Track A
  collects all `file` values; Track B emits one `file=<enc(path)>` per path.

## Out of scope (follow-ups)

- Paginated/lazy file-contents in the initial `/api/diff` payload (big reviews
  still send every changed file's bytes up front).
- Sharing one `EventSource` between `useDiff` and `useReviewState`.
- SSE per-subscriber serialization (`to_sse` re-serializes per stream).
