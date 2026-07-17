# diffx glow-up: live review, presence, and direct manipulation

Design plan for a coordinated set of changes to diffx (`~/ai-tools/diffx`).
Goal: make diffx work equally well for its two real usage modes — (1) bespoke
diffs scoped to a question for the agent, (2) pair-programming on the tip of a
live branch — with tight, non-disruptive feedback loops in both.

Current architecture (kept): local Hono server, React 19 + Vite UI rendered by
`@pierre/diffs` CodeView, SSE event stream, agent attaches via Monitor. The
diff is computed live per request by shelling out to git (`git.ts`); there is
no snapshot store. The changes below are granularity, state-ownership, and
presence upgrades — not a re-architecture. Explicitly out of scope: CRDT/OT,
heavier frameworks, desktop-first work.

## Stage 1 — Refresh that doesn't destroy anything

Today any content change remounts the entire CodeView (`contentRevision` is a
single global counter used as its key, `CodeViewWrapper.tsx:237-254`), and
in-flight comment text is lost because it's `CommentForm`-local state.

1. **Per-file diff slice.** Add `GET /api/diff?file=<path>` returning one
   file's entry (patch fragment + both `SideContents`). The full `/api/diff`
   stays for initial load.
2. **Per-path change events.** `file-written` (and the new fs-watcher events,
   Stage 2) carry a concrete `path`; `path: null` remains the "everything"
   fallback (`diffx refresh`).
3. **Per-file remount.** Replace the global `contentRevision` with a per-file
   revision map keyed by file path; only the changed file's inner CodeView
   remounts. Keep the existing scroll capture/restore, scoped per file.
4. **Lift draft text.** Move the comment/suggestion form's in-progress text up
   into the `pending` draft map (update on keystroke) so a remount rehydrates
   the form with its content intact. Drafts must survive any refresh.

## Stage 2 — fs-watcher + three refresh modes

1. **Server-side watcher, always on.** chokidar over the repo root, ignoring
   `.git/`, `node_modules/`, and other obvious noise; ~200ms debounce; keep a
   content-hash per diff-relevant file so mtime-only churn (git operations)
   emits nothing. On a real change, broadcast `file-changed {path}`.
2. **Refresh-mode setting (client policy only).** Enum in settings + toolbar:
   - `manual` — never auto-apply; toast "N files changed — refresh?" plus a
     staleness badge on affected files in the file tree.
   - `live-unless-active` (default) — auto-apply per-file refetch, except a
     file the user is "active" in (open draft form, focused suggest editor, or
     file-editor modal on that file); that file gets the toast and applies on
     close/submit.
   - `ultra` — always apply immediately.
3. Keep `POST /api/refresh` and add a manual ↻ toolbar button (client-side
   `load()`), as escape hatches.

## Stage 3 — Comment re-anchoring

Live refresh shifts line numbers; anchors must track.

- On a file change, the server remaps each open comment/draft anchor for that
  file: exact `lineContent` match near the old position first, then fuzzy
  (trimmed/normalized) search, else mark the comment `outdated` (GitHub
  semantics). Broadcast updated anchors so UI, watcher, and agent agree.
- Server-side because three consumers need identical answers.

## Stage 4 — Presence, principal-based lifecycle, ws Monitor

1. **Watcher surfaces browser presence.** `diffx watch` currently swallows
   `state` events (`subcommands.ts:206-214`). Track last-seen `uiCount` and
   emit `{"type":"clients","browsers":N}` on transitions, debounced ~3-5s so a
   tab reload doesn't fire.
2. **Principal-based idle shutdown.** Key the idle timer on `uiCount` (browser
   = principal), not total subscriber count — the watcher/agent must never
   hold the server alive. When the last browser leaves and the grace expires:
   broadcast a terminal `review-ended` event, then exit. `diffx watch` exits
   on `review-ended` with code 3 ("reviewer left without submitting"; 0 stays
   "submitted seen", 2 stays "connection dropped"). Also shut down if no
   browser ever connects within ~3 minutes of launch.
3. **WebSocket endpoint for the agent.** Add `/api/events-ws` emitting the
   same JSON lines as `diffx watch` stdout. The Claude skill connects the
   Monitor tool's native `ws:` source directly — no watcher subprocess.
   Subscribers over ws register as `role: 'agent'`; show an "agent connected"
   dot in the toolbar next to the existing watcher indicator. Keep `diffx
   watch` (SSE) for humans/manual use.

## Stage 5 — Draft comments

- Comment schema gains `status: 'draft'`. A second button next to the comment
  form's submit: "Save as draft".
- Drafts render normally in the UI (visually marked); the watcher/ws stream
  suppresses them.
- "Done reviewing" (and a dedicated "Post drafts" button) flips all drafts
  live in one batch — each then emits a normal `comment-added`.
- Server-side (not a client queue) so drafts survive tab reloads.

## Stage 6 — Character-level selection: comment + direct delete

- **Schema v3.** Optional `startColumn`/`endColumn` (0-based, on the anchor
  lines) + `selectedText` on comments. Line-only comments stay valid. Bump the
  clipboard payload version; the agent-facing rendering includes the exact
  selected text and offsets.
- **Selection pill.** On native text selection inside the code surface, float
  a small pill at the selection end: **💬 Comment · ✕ Delete**. Map the DOM
  range to (line, col) via the rendered line elements.
- **Delete is a direct write.** ✕ (or Backspace with an active selection)
  splices the range out of the working-tree file server-side (reuse the
  `writeWorkingTreeFile` path), broadcasts `file-changed`, and emits a watcher
  event `{"type":"user-edit","action":"delete","filePath":…,"range":…,
  "deletedText":…}` so the agent's context stays current without re-reading.
  Show an **Undo** toast; the server keeps a small per-session undo buffer of
  spliced text to restore on demand. (Advisory deletes = just write a comment.)

## Stage 7 — Suggest-edit fixes

1. **Event isolation.** The CodeMirror suggest editor is mounted inside
   Pierre's CodeView annotation surface; Pierre's document-level gutter-drag
   handlers eat text-selection drags. Stop propagation of
   mousedown/mousemove/mouseup/keydown at the CM container boundary (or portal
   the editor out of CodeView's DOM). This is the main felt bug.
2. **Escape scoping.** The `Prec.high` Escape binding discards the whole form;
   let CodeMirror handle Escape when it has something to do, and confirm
   before discarding a non-trivial edit.
3. Re-evaluate the `requestAnimationFrame` focus grab once (1) lands.

## Stage 8 — Durability + skill

- Persist comments/drafts/undo buffer as JSON next to the session state file;
  load on start so a server restart or diffx upgrade doesn't eat a review.
- Update `skills/diffx/SKILL.md`: Monitor connects via ws; don't call
  `refresh` when the watcher is on (fs events cover it); `user-edit` events
  are context updates, not requests; `review-ended` / exit code 3 semantics;
  draft-suppression note.

## Ordering rationale

1 fixes the disruptive refresh that exists today; 2 delivers the modes; 3 is
required before `ultra` mode is honest; 4 kills the liveness ice-cream-cone;
5-6 are the new interaction features; 7 is an independent felt bug; 8 closes
the loop. Stages are independently shippable in this order.
