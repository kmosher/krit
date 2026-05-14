---
name: diffx-review
description: "End-to-end code review with diffx: launch the UI, wait for the user to click Submit, then apply requested changes. Use when the user invokes /diffx-review (or asks to review changes locally)."
user_invocable: true
---

# Diffx-driven code review

Single-skill flow: launch diffx, let the user leave inline comments in the browser, wake up when they click **Submit to Claude**, apply the requested changes.

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

## Step 2: Spawn the watcher (also background)

```bash
diffx wait-for-submit
```

Also `run_in_background: true`. This subscribes to diffx's SSE event stream and blocks until the user clicks **Submit to Claude** in the browser. The act of subscribing is what lights up the Submit button in the UI — if no watcher is attached, the button greys out and the user has to fall back to "Copy comments."

**Exit codes:**
- `0` — submit fired, the user is done
- `2` — server closed before submit (diffx crashed, port conflict, user killed it)
- `130` — Ctrl+C / SIGTERM

## Step 3: Hand off and end the turn

Tell the user, briefly:

> diffx is running. Leave inline comments in the browser; click **Submit to Claude** when done. I'll wake up and apply your requests.

Then END THE TURN. Do not poll, do not block, do not start checking on things. When `diffx wait-for-submit` exits, you will receive a task-completion notification — that's the wake-up signal.

## Step 4 (on wake-up): Process comments

When the `diffx wait-for-submit` task fires its completion notification:

- **Exit 0** → fetch and process:
  ```bash
  diffx comments open
  ```
  Iterate over the JSON array. For each:
  - **Change request** ("rename x", "extract helper", "use Map here") → Read the file, apply the change via Edit, then:
    ```bash
    diffx reply <id> "Done. <one-line summary of what changed>"
    diffx resolve <id>
    ```
  - **Question** ("why not X?", "is this thread-safe?") → answer in reply, leave open:
    ```bash
    diffx reply <id> "<your answer>"
    ```
  - **Ambiguous** → reply asking for clarification, leave open.

- **Exit 2** → diffx server is gone. Tell the user something went wrong and stop. Don't try to re-launch silently.
- **Exit 130** → user cancelled. Stop.

If multiple comments interact (a rename that affects several places, etc.), apply the edits together but reply/resolve each one individually.

## Step 5: Summary

Once everything is processed, report briefly: N applied, M answered, K left open for clarification.

## Manual fallback

If the user can't or won't use Submit (browser closed, no watcher attached, working offline-from-Claude), they can click **Copy** in the diffx UI to grab all comments as XML and paste them into the conversation. Process them the same way as step 4 — same `diffx comments open` / `reply` / `resolve` plumbing, just human-triggered.
