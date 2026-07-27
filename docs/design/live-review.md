# diffx glow-up: live review, presence, and direct manipulation

> **Status: implemented** (all stages landed as of `3aa05d6`, 2026-07-17).
> One deviation from the plan below: Stage 4 kept `diffx watch` as an SSE
> fallback for humans, but it was retired entirely once `/api/events-ws`
> proved out — its exit-code contract moved to ws close semantics (see
> `skills/diffx/SKILL.md` Step 5), and `diffx wait-for-submit` remains the
> batch-flow entry point. This doc is retained as design rationale.
>
> The project is now `krit` (Rust server, same wire API); "diffx" below is the
> historical name. **Stage 2's refresh policy has since been superseded by
> inline editing — read "Inline editing (2026-07)" at the bottom before
> relying on anything here about `file-written`, refresh modes, or what makes
> a file "active".**

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

## Decisions

Implemented: all 8 stages. See branch `kmosher/glowup` for commit-by-commit
detail. Stage 6's client-side DOM-selection mapping and pill/drag
interaction are implemented but not independently browser-verified in
this pass — see that entry below.

- **Stage 1 — file-set changes still fully remount.** `CodeViewHandle` (the
  `@pierre/diffs` API surface diffx builds on) has `updateItem` and
  `addItems` but no `removeItem`. A file's content changing is patched in
  place via `updateItem` (replacing `item.fileDiff`, bumping `item.version`);
  a file being *added or removed* from the diff (new untracked file
  appearing, a revert dropping one back to identical) still triggers a full
  `<CodeView>` remount, since there's no way to shrink the item list
  in place. This is the common case (content edits) done right and the rare
  case (file added/removed) falling back to the old behavior, not a partial
  implementation of the per-file goal.
- **Stage 1 — draft lifting scoped to the new-comment form.** Only the
  comment/suggest-edit draft form (`CodeViewWrapper`'s `pending` map) had its
  text lifted out of local state. Reply forms (`CommentBubble`) were left
  alone — they're short-lived, never coincide with a remount, and lifting
  them would require plumbing per-comment draft state through a different
  owner.
- **Stage 2 — `file-written` bypasses refreshMode entirely; only
  `file-changed` is gated.** `file-written` fires from the in-browser editor
  save or `diffx refresh` — both are the user/agent asking directly, so they
  always apply immediately. Only ambient fs-watcher discovery
  (`file-changed`) is subject to manual/live-unless-active/ultra policy.
  *(Superseded: an open inline edit session now defers every event type,
  `file-written` included. See below.)*
- **Stage 2 — "active" file = open draft or open FileEditorModal.**
  live-unless-active's activity signal doesn't (yet) include "the file is
  currently in the scrolled viewport" — only an open comment/suggest draft
  or the file-editor modal counts. Scroll-position activity would need
  wiring `onActiveFileChange` into the same set and wasn't worth the extra
  surface for this pass. *(Superseded: an open inline edit session is a third
  activity signal, and a stronger one. See below.)*
- **Stage 3 — re-anchoring scoped to open, additions-side comments.**
  Deletion-side comments anchor to the diff's "old" side, which by
  definition has no live counterpart in the working tree to re-anchor
  against, so they're left alone. Resolved comments aren't re-anchored
  either — a resolved thread's exact position is no longer load-bearing.
- **Stage 3 — the in-browser editor save re-anchors twice.** `PUT
  /api/file-content` calls `reanchorAndBroadcast` directly (so the response
  already reflects new positions), and the fs-watcher independently detects
  the same write ~200ms later and calls it again. The second call is a no-op
  (positions already match) — redundant but harmless, not worth suppressing.
- **Stage 4 — `/api/events-ws` hand-rolled with `ws`, not an
  `@hono/node-server` bump.** The installed version (1.19.12) has no `/ws`
  export in its `dist/`; per direction, `WebSocketServer({noServer:true})`
  attaches to the raw `http.Server` `serve()` returns via
  `server.on('upgrade', ...)`, gated to the `/api/events-ws` path.
  `Subscriber` became transport-agnostic (`send(payload): Promise<void>`)
  so `broadcast`/`sendTo` don't care whether a subscriber is SSE or native
  ws. Verified with a small Node `ws` client: connects, receives
  broadcasts, gets the debounced `clients` line, and `agentCount` correctly
  returns to 0 after disconnect.
- **Stage 5 — drafts are opt-in, not opt-out, at the read boundary.**
  `GET /api/comments` filters out drafts unless the caller passes
  `?includeDrafts=true`, which only the browser UI's fetch sends. This
  wasn't explicitly called out in the design ("the watcher/ws stream
  suppresses them" only mentions the push side) but was necessary:
  `diffx comments` reads this same endpoint directly, and without the
  filter it would leak drafts the reviewer hadn't posted yet, bypassing the
  SSE-level suppression entirely.
- **Stage 5 — no per-draft "post one" affordance.** Only batch posting
  exists (`POST /api/drafts/post`, wired to the toolbar's "Post drafts"
  button and to Submit). A reviewer wanting to post a single draft ahead of
  the rest currently has to post all of them; scoped out to keep the surface
  small, since the server-side PUT path (`status: 'open'` on one comment)
  already exists and could grow a dedicated button later without a schema
  change.
- **Stage 6 — implemented, browser-verification split out.** Mapping a
  native DOM text selection to (line, column) offsets and positioning a
  floating pill is UI geometry that's only really confirmed by dragging a
  selection in a running browser — out of scope for this agent's own
  toolset (curl-only smoke testing). It's implemented based on reading
  `@pierre/diffs`' actual rendered output (open shadow root; `data-line`
  per rendered line; no side attribute, so side comes from Pierre's own
  hover tracking instead of DOM guessing — see `selectionMapping.ts`'s
  header comment for the full reasoning), with live Chrome verification
  of the interaction itself handled as a separate pass by whoever has
  browser automation available. Everything not dependent on live DOM
  interaction (schema v3 persistence/validation, delete-splice, undo
  buffer, `user-edit` event) was verified via curl against a running
  server.
- **Stage 6 — side is a best-effort heuristic, not a certainty.** There's
  no DOM attribute distinguishing which split-view column (additions vs
  deletions) a selection's text belongs to, so the pill uses whichever
  side the pointer most recently hovered (`onLineEnter`'s `annotationSide`,
  already tracked for the existing line-selection-clearing behavior). If
  the mouse ends a drag over a different line/side than where it started
  hovering, the anchor's `side` could be wrong — a real gap a live browser
  pass should specifically probe.
- **Stage 7 — event-guard scope is every annotation, not just the CM
  editor.** The design calls out "the CodeMirror suggest editor" as the
  fix's target; the implementation (`AnnotationEventGuard` in
  `CodeViewWrapper.tsx`) wraps the whole annotation render — comment form,
  suggest editor, *and* `CommentBubble`'s reply form — since all three sit
  inside the same annotation surface Pierre's gutter-drag listeners can
  hijack, and one wrapper covers all of them for the same cost as one.
- **Stage 8 — no undo-buffer persistence.** The design's "persist ...
  undo buffer" doesn't apply: no undo buffer exists (that's Stage 6's, not
  built this pass). Only comments (including drafts) persist.

## Inline editing (2026-07)

`@pierre/diffs` 1.3.0 brought an editor of its own (`item.edit`, `EditProvider`,
`onItemEditComplete`), and it — not `FileEditorModal` — is now the main editing
flow: you type in the diff, in place, on the lines you were reading.
`FileEditorModal` stays as the drop-back for "I want the whole file, including
the parts the diff doesn't show", reached from the ⤢ in the file header.

This changes the refresh policy above in three ways.

**An open edit session defers every event type, in every refresh mode.** The
Stage 2 split — ambient discovery is gated, direct writes always apply — was
built when nothing in the UI held document state that a refetch could destroy.
An edit session does: the refetch replaces the item's `fileDiff`, and the live
editor is rendering from it. So `editingFiles` is checked in `useDiff` ahead of
the per-event branches, and it wins over `ultra` and over `file-written` too.
This is the only case where a mode says "apply immediately" and krit doesn't.

**A queued change is offered, not applied.** The file header grows an Apply
button; taking it fetches the working-tree content and hands the delta to the
live editor via `Editor.applyEdits`, which Pierre makes history-equivalent to
typing — so the agent's write arrives as *one* undo step the reader can ⌘Z away
like their own. `computeSingleEdit` (`src/ui/utils/textEdits.ts`) turns the two
full texts into that one replacement; it deliberately produces a single
possibly-wide range rather than a minimal edit script, because a wide range is
one undo entry and correctness at the surrogate-pair and CRLF boundaries is
easier to state than to diff.

**Saving is checked, not just conventional.** Ending a session writes the whole
file, so a queued change outstanding at Done would be clobbered. Two mechanisms,
deliberately layered:

- The header asks — inline, never `confirm()`. A native modal freezes the page
  for anything driving the browser programmatically, and krit's whole reason to
  exist is being driven by an agent. The same rule holds for
  `FileEditorModal`'s discard prompt.
- `PUT /api/file-content` honors `If-Match` against an ETag over the
  working-tree bytes and answers **412** on a mismatch. The question above is a
  convention, and every convention loses a race eventually; this is the part
  that can't be raced past. It is opt-in per request — a PUT without `If-Match`
  is last-writer-wins, as it always was — so no existing caller changed
  behaviour. A refused inline save is held in a conflict bar rather than
  reported as lost, since Pierre has torn the editor down by the time the
  server answers.

**Deferred remounts.** A file appearing or vanishing from the diff normally
remounts the whole CodeView (see the Stage 1 decision above). That destroys
every editor instance, and Pierre's teardown path pushes no completion — the
typing would go silently. So the remount is owed rather than taken while any
session is open, and runs when the last one closes. The item list stays one
file stale until then, which is the same bargain `live-unless-active` already
makes.

### Still open

- **`file-written{path}` remains agent-visible** (`agent_visible` in
  `server.rs` filters only `path: None`). Inline Done makes it fire where the
  modal used to be a rare event, but the rate is still one frame per completed
  human edit session — bounded by a person clicking a button, which is exactly
  the human-originated signal that filter is meant to let through. Kept on
  purpose; revisit if an agent ever starts calling `PUT /api/file-content`
  itself, at which point it would be paying to hear its own writes.
- **Drafts still don't survive a reload.** Stage 8 persisted comments, not
  in-progress form text; an inline edit session is likewise memory-only. Warn
  before advising a refresh mid-review.
- **An edit session and a comment draft open on the same file at once is
  untested.** Both live in Pierre's shadow root, historically where the WebKit
  trouble was.
