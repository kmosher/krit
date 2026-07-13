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
diffx -- --staged                 # only staged
diffx -- HEAD~3                    # last 3 commits
diffx -- origin/main...HEAD        # this branch's own changes vs main (see below)
```

### Picking the diff range for "review this branch"

To review a branch's *own* changes, use **three-dot** `origin/main...HEAD`, not
two-dot `main..HEAD`. The difference bites:

- **Two-dot `A..B`** diffs the two *tip commits*. If the base ref has moved on
  since the branch was cut (it usually has), every commit that landed on the base
  meanwhile shows up — typically as a wall of phantom *deletions* in unrelated
  files. This is the #1 way the diff comes out wrong.
- **Three-dot `A...B`** diffs from the **merge-base**, so you get exactly what the
  branch added, regardless of how far the base advanced. This is what you want.

Also pick a **fresh** base ref: prefer `origin/main` (or `origin/master`) over
local `main`/`master`, which is often tens of commits stale. When unsure which is
the default branch, resolve it once: `git rev-parse --abbrev-ref origin/HEAD`
(e.g. `origin/main`). Bulletproof equivalent if a ref is ambiguous:
`diffx -- "$(git merge-base origin/main HEAD)..HEAD"`.

If the user names a different base ("vs staging", "since the v2 tag"), swap it in —
but keep it three-dot against a fresh ref.

Run with `run_in_background: true` so the server stays alive while the user reviews. diffx writes a state file at `$CLAUDE_TMPDIR/diffx-state.json` so the other subcommands auto-discover it.

**Always pass `dangerouslyDisableSandbox: true` on this Bash call.** diffx spawns a child `open` process to launch the browser tab; the Claude Bash sandbox blocks that child even though `diffx` itself would run fine, and the tab silently fails to open ("browser-open helper exited with code 1"). Disabling the sandbox on the parent call lets the spawned `open` through.

`diffx` automatically opens a new browser tab pointed at the local server. Once the tab is open, the server sits idle waiting for the user to leave inline comments — it is **not** doing any work in the background and will not proceed on its own. Activity resumes only when the user comments (you see it via `diffx watch`) or clicks **Done reviewing**.

## Step 2: Stream comment events (Monitor)

```bash
diffx watch
```

Run this as a **Monitor task** (not a background Bash task). `diffx watch` subscribes to the diffx event stream and writes one JSON line to stdout per event. Each line is a wake-up notification — the Monitor surfaces them as they arrive, so you can process the user's comments as soon as they leave them.

Line shapes:

```json
{"type":"comment-added","comment":{"id":"...","filePath":"...","lineNumber":42,"endLine":42,"body":"...", ...}}
{"type":"reply-added","commentId":"...","reply":{"id":"...","body":"...","author":"user","createdAt":...},"commentStatus":"open"}
{"type":"submitted","timestamp":...}
```

Comments carry both `lineNumber` (start) and `endLine` (inclusive end). For a single-line comment they're equal; when the user drag-selected a range in the gutter, `endLine > lineNumber` and `lineContent` contains the selected lines joined with `\n`. Treat the range as the scope of the comment when applying changes.

Replies carry `author: 'user' | 'agent'`. You only see `reply-added` events for `author: 'user'` (the server suppresses your own CLI replies). The `commentStatus` field on the event is the post-event status of the parent comment — if the user replied to a comment you'd already resolved, the server auto-reopens it and `commentStatus` will be `"open"` so you can react without re-fetching.

The clipboard "Copy comments" payload carries a `<code-review-comments version="2">` root. Future shape changes will bump that version; if you see a higher version than you understand, fall back to `diffx watch` / `diffx comments` (always the wire-current shape) rather than parsing the payload.

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
    diffx refresh
    diffx reply <id> "Done. <one-line summary of what changed>"
    diffx resolve <id>
    ```
    `diffx refresh` tells the open browser tab to refetch the diff so the edit shows up immediately — your Edit-tool writes don't go through diffx's own file-write path, so nothing else triggers that refresh.
  - **Question** ("why not X?", "is this thread-safe?") → answer in reply. If you're confident the answer fully addresses it, also `diffx resolve <id>`. If it might prompt follow-up, leave it open.
    ```bash
    diffx reply <id> "<your answer>"
    ```
  - **Ambiguous** → reply asking for clarification, leave open.

- **`reply-added`** — the user replied to one of your earlier replies (probably pushback or follow-up). Read the reply, treat it like a new request scoped to that comment, and respond the same way.

- **`submitted`** — the user clicked Done reviewing. Move to Step 5.

End the turn after handling the event(s). The Monitor will wake you again on the next one.

**Self-echo guard:** your own `diffx reply` calls don't produce `reply-added` events (the server suppresses them via `?source=cli`). You only wake on human input.

## Step 5: Wrap up (on `submitted`)

Once you see the `submitted` line, the Monitor will exit on its own. Summarize briefly: N applied, M answered, K left open (and why).

## Failure modes

- **Monitor exits non-zero before submit** → diffx server is gone (crash, killed, port conflict). Tell the user and stop. Don't silently re-launch.
- **No watcher attached when user tries to click Done** → they'll see "No watcher" in the UI. They can either start the watch from Claude or fall back to Copy.

## Manual fallback

If the user can't or won't use the streaming flow (browser closed, no Monitor attached, working offline-from-Claude), they can click **Copy** in the diffx UI to grab all comments as XML and paste them into the conversation. Process them via the same `diffx comments open` / `reply` / `resolve` plumbing.
