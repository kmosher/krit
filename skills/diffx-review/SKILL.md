---
name: diffx-review
description: "End-to-end code review with diffx: launch the UI, stream the user's inline comments as they're written, reply/resolve in real time, finish when the user clicks Done reviewing. Use when the user invokes /diffx-review (or asks to review changes locally)."
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
diffx -- --staged          # only staged
diffx -- HEAD~3            # last 3 commits
diffx -- main..HEAD        # current branch vs main
```

Run with `run_in_background: true` so the server stays alive while the user reviews. diffx writes a state file at `$CLAUDE_TMPDIR/diffx-state.json` so the other subcommands auto-discover it.

## Step 2: Stream comment events (Monitor)

```bash
diffx watch
```

Run this as a **Monitor task** (not a background Bash task). `diffx watch` subscribes to the diffx event stream and writes one JSON line to stdout per event. Each line is a wake-up notification — the Monitor surfaces them as they arrive, so you can process the user's comments as soon as they leave them.

Line shapes:

```json
{"type":"comment-added","comment":{"id":"...","filePath":"...","lineNumber":42,"body":"...", ...}}
{"type":"reply-added","commentId":"...","reply":{"id":"...","body":"...","createdAt":...}}
{"type":"submitted","timestamp":...}
```

Subscribing also lights up the **Done reviewing** button in the browser — if no watcher is attached, the button greys out and the user falls back to "Copy comments."

## Step 3: Hand off and end the turn

Tell the user, briefly:

> diffx is running. Leave inline comments in the browser — I'll process each one as you write it. Click **Done reviewing** when you're finished.

Then END THE TURN. The Monitor will wake you when an event arrives.

## Step 4 (on each wake-up): Handle one event

Read the new line(s) from the Monitor. For each:

- **`comment-added`** — read `comment.filePath`/`lineNumber`/`body`. Decide what it is:
  - **Change request** ("rename x", "extract helper", "use Map here") → Read the file, apply the change via Edit, then:
    ```bash
    diffx reply <id> "Done. <one-line summary of what changed>"
    diffx resolve <id>
    ```
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
