---
name: diffx
description: "End-to-end code review with diffx: launch the UI, stream the user's inline comments as they're written, reply/resolve in real time, finish when the user clicks Done reviewing. Use when the user invokes /diffx (or asks to review changes locally)."
user_invocable: true
---

# Diffx-driven code review

Streaming flow: launch diffx, watch the user's comments arrive one at a time, reply (and optionally resolve) each one as it comes in, finish when the user clicks **Done reviewing**.

## Step 1: Launch the server (background)

```bash
diffx [-- <git-diff-args>]
```

No args reviews the working tree (staged + unstaged + untracked). Common variants:

```bash
diffx -- --staged                              # only staged
diffx -- HEAD~3                                 # last 3 commits
diffx -- "$(git merge-base origin/main HEAD)"   # this branch's changes vs main, incl. uncommitted (see below)
```

### Picking the diff range for "review this branch"

To review a branch's *own* changes, the default should be **working tree vs
merge-base**:

```bash
diffx -- "$(git merge-base origin/main HEAD)"
```

A single commit argument makes git diff the **working tree** against that
commit. This matters because of Step 4's edit loop: when you apply a change the
user requested and run `diffx refresh`, an uncommitted edit is only visible if
the diff range includes the working tree. A commits-only range (`A...HEAD`)
silently shows stale code after refresh — the user sees their comment
"resolved" against a diff that never changed. (Committing after every applied
comment also works, but don't rely on remembering to.)

Ranges to avoid, and why:

- **Two-dot `main..HEAD`** diffs the two *tip commits*. If the base ref has
  moved on since the branch was cut (it usually has), every commit that landed
  on the base meanwhile shows up — typically as a wall of phantom *deletions*
  in unrelated files. This is the #1 way the diff comes out wrong.
- **Three-dot `origin/main...HEAD`** fixes the phantom-deletion problem (it
  diffs from the merge-base) but is commits-only — uncommitted edits never
  appear, so `diffx refresh` looks broken mid-review. Use it only when you
  specifically want to exclude working-tree noise *and* you commit each
  applied change before refreshing.

Also pick a **fresh** base ref: prefer `origin/main` (or `origin/master`) over
local `main`/`master`, which is often tens of commits stale. When unsure which is
the default branch, resolve it once: `git rev-parse --abbrev-ref origin/HEAD`
(e.g. `origin/main`).

If the user names a different base ("vs staging", "since the v2 tag"), swap it
into the `merge-base` call — the working-tree-vs-merge-base shape stays the same.

Run with `run_in_background: true` so the server stays alive while the user reviews. diffx writes a state file at `$CLAUDE_TMPDIR/diffx-state.json` so the other subcommands auto-discover it.

**Always pass `dangerouslyDisableSandbox: true` on this Bash call.** diffx spawns a child `open` process to launch the browser tab; the Claude Bash sandbox blocks that child even though `diffx` itself would run fine, and the tab silently fails to open ("browser-open helper exited with code 1"). Disabling the sandbox on the parent call lets the spawned `open` through.

`diffx` automatically opens a new browser tab pointed at the local server. Once the tab is open, the server sits idle waiting for the user to leave inline comments — it is **not** doing any work in the background and will not proceed on its own. Activity resumes only when the user comments (you see it via `diffx watch`) or clicks **Done reviewing**.

## Step 2: Stream comment events (Monitor)

```bash
diffx watch
```

Run this as a **Monitor task** (not a background Bash task). `diffx watch` subscribes to the diffx event stream and writes one JSON line to stdout per event. Each line is a wake-up notification — the Monitor surfaces them as they arrive, so you can process the user's comments as soon as they leave them.

Alternatively, if Monitor's native `ws:` source is available in this environment, connect it directly to `ws://<host>:<port>/api/events-ws` instead of spawning `diffx watch` as a subprocess — same JSON line shapes below, one message per event, no separate process to manage. `diffx state` gives you the port. Registering over this endpoint also lights up an "Agent connected" indicator in the browser toolbar (distinct from the `diffx watch`/watcher indicator, since the two are different subscriber roles).

Line shapes:

```json
{"type":"comment-added","comment":{"id":"...","filePath":"...","lineNumber":42,"endLine":42,"body":"...", ...}}
{"type":"comment-updated","comment":{"id":"...","lineNumber":45,"outdated":false, ...}}
{"type":"reply-added","commentId":"...","reply":{"id":"...","body":"...","author":"user","createdAt":...},"commentStatus":"open"}
{"type":"clients","browsers":1}
{"type":"submitted","timestamp":...}
{"type":"review-ended","reason":"idle"|"no-browser"}
```

Comments carry both `lineNumber` (start) and `endLine` (inclusive end). For a single-line comment they're equal; when the user drag-selected a range in the gutter, `endLine > lineNumber` and `lineContent` contains the selected lines joined with `\n`. Treat the range as the scope of the comment when applying changes.

Replies carry `author: 'user' | 'agent'`. You only see `reply-added` events for `author: 'user'` (the server suppresses your own CLI replies). The `commentStatus` field on the event is the post-event status of the parent comment — if the user replied to a comment you'd already resolved, the server auto-reopens it and `commentStatus` will be `"open"` so you can react without re-fetching.

**`comment-updated`** fires when a live file edit shifted a comment's anchor (or restored/broke the match): `lineNumber`/`endLine` reflect the new position, `outdated: true` means the server couldn't confidently re-match it and the position may be stale. Update your working copy of that comment's location rather than treating it as a new comment.

**Draft comments never reach you.** The user can save a comment as a draft instead of posting it — drafts are invisible to `diffx watch`/`diffx comments` until the user posts them (or clicks Done reviewing, which posts any stragglers). You will never see a draft comment's `comment-added` until that happens; there's nothing to do differently, just don't assume every comment the user has typed is one you've seen.

The clipboard "Copy comments" payload carries a `<code-review-comments version="3">` root. v3 adds `startColumn`/`endColumn` on `<comment>` and a `<selected>` block, both present only when the reviewer commented on an exact text selection rather than whole lines — treat `<selected>` as the precise substring to act on, more precise than `<code>`'s full line(s). Future shape changes will bump the version again; if you see a higher version than you understand, fall back to `diffx watch` / `diffx comments` (always the wire-current shape) rather than parsing the payload.

Subscribing also lights up the **Done reviewing** button in the browser — if no watcher is attached, the button greys out and the user falls back to "Copy comments."

## Step 3: Hand off and end the turn

Tell the user — in your own words — that:

- A new browser tab has been opened with the diff (mention it explicitly; the user may have the terminal focused and miss the tab).
- The diffx server is now **waiting for them** to leave inline comments. You'll process each one as it arrives. Click **Done reviewing** when finished.

Keep it brief, but make those two points clear.

Then END THE TURN. The Monitor will wake you when an event arrives.

## Step 4 (on each wake-up): Handle one event

Read the new line(s) from the Monitor. For each:

- **`comment-added`** — read `comment.filePath`/`lineNumber`/`body`. Decide what it is:
  - **Change request** ("rename x", "extract helper", "use Map here") → Read the file, apply the change via Edit, then:
    ```bash
    diffx reply <id> "Done. <one-line summary of what changed>"
    diffx resolve <id>
    ```
    Don't call `diffx refresh` for this — diffx runs an always-on fs-watcher
    that picks up your Edit-tool writes on its own (content-hashed, ~200ms
    debounce) and refreshes the open browser tab automatically. `diffx
    refresh` is a manual escape hatch for the rare case the watcher missed
    something (e.g. a change made before diffx started watching); reach for
    it only if the user says the diff looks stale.
  - **Question** ("why not X?", "is this thread-safe?") → answer in reply. If you're confident the answer fully addresses it, also `diffx resolve <id>`. If it might prompt follow-up, leave it open.
    ```bash
    diffx reply <id> "<your answer>"
    ```
  - **Ambiguous** → reply asking for clarification, leave open.

- **`reply-added`** — the user replied to one of your earlier replies (probably pushback or follow-up). Read the reply, treat it like a new request scoped to that comment, and respond the same way.

- **`submitted`** — the user clicked Done reviewing. This is **not** the end of the session — they can still leave more comments or reply to yours, and you'll keep waking up for them. Acknowledge briefly (e.g. "Got it — I'll keep watching in case you have more comments") and end the turn as usual. Do not summarize or wrap up yet; that happens in Step 5, when the Monitor itself exits.

End the turn after handling the event(s). The Monitor will wake you again on the next one.

**Self-echo guard:** your own `diffx reply` calls don't produce `reply-added` events (the server suppresses them via `?source=cli`). You only wake on human input.

## Step 5: Wrap up (when the Monitor exits)

The diffx server shuts itself down once every browser tab has disconnected (with a short grace period for refreshes) — this Monitor's own connection doesn't keep it alive on its own. That's what ends the session, not the `submitted` event. When the Monitor process exits:

- **Exit 0** — the user clicked Done reviewing at some point before closing the tab. Summarize briefly: N applied, M answered, K left open (and why).
- **Exit 3** — the server broadcast `review-ended` (the last browser tab left, or none ever connected) before `submitted` was ever seen. The reviewer walked away without clicking Done reviewing. Tell the user what you got through (if anything) and that the review session ended without an explicit sign-off; don't silently re-launch.
- **Exit 2** — the connection dropped some other way (crash, killed, port conflict) with neither `submitted` nor `review-ended` seen. Tell the user and stop; don't silently re-launch.

## Failure modes

- **No watcher attached when user tries to click Done** → they'll see "No watcher" in the UI. They can either start the watch from Claude or fall back to Copy.

## Manual fallback

If the user can't or won't use the streaming flow (browser closed, no Monitor attached, working offline-from-Claude), they can click **Copy** in the diffx UI to grab all comments as XML and paste them into the conversation. Process them via the same `diffx comments open` / `reply` / `resolve` plumbing.
