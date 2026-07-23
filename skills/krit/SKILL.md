---
name: krit
description: "End-to-end code review with krit (the Rust diffx v2): launch the UI, stream the user's inline comments as they're written, reply/resolve in real time, finish when the user clicks Done reviewing. Use when the user invokes /krit or asks to review changes with krit. For /diffx (the v1 fallback), use the diffx skill instead."
---

# Krit-driven code review

Streaming flow: launch krit, watch the user's comments arrive one at a time, reply (and optionally resolve) each one as it comes in, finish when the user clicks **Done reviewing**.

krit is wire-compatible with diffx v1 but is a single Rust binary with no `watch` subcommand — event streaming attaches straight to the server's WebSocket endpoint (Step 2).

## Step 1: Launch the server (background)

```bash
krit [-- <git-diff-args>]
```

No args reviews the working tree (staged + unstaged + untracked). Common variants:

```bash
krit -- --staged                              # only staged
krit -- HEAD~3                                 # last 3 commits
krit -- "$(git merge-base origin/main HEAD)"   # this branch's changes vs main, incl. uncommitted (see below)
```

### Picking the diff range for "review this branch"

To review a branch's *own* changes, the default should be **working tree vs merge-base**:

```bash
krit -- "$(git merge-base origin/main HEAD)"
```

A single commit argument makes git diff the **working tree** against that commit. This matters because of Step 4's edit loop: when you apply a change the user requested and run `krit refresh`, an uncommitted edit is only visible if the diff range includes the working tree. A commits-only range (`A...HEAD`) silently shows stale code after refresh — the user sees their comment "resolved" against a diff that never changed.

Ranges to avoid, and why:

- **Two-dot `main..HEAD`** diffs the two *tip commits*. If the base ref has moved on since the branch was cut (it usually has), every commit that landed on the base meanwhile shows up — typically as a wall of phantom *deletions* in unrelated files. This is the #1 way the diff comes out wrong.
- **Three-dot `origin/main...HEAD`** fixes the phantom-deletion problem (it diffs from the merge-base) but is commits-only — uncommitted edits never appear, so `krit refresh` looks broken mid-review. Use it only when you specifically want to exclude working-tree noise *and* you commit each applied change before refreshing.

Also pick a **fresh** base ref: prefer `origin/main` (or `origin/master`) over local `main`/`master`, which is often tens of commits stale. When unsure which is the default branch, resolve it once: `git rev-parse --abbrev-ref origin/HEAD`.

If the user names a different base ("vs staging", "since the v2 tag"), swap it into the `merge-base` call — the working-tree-vs-merge-base shape stays the same.

Run with `run_in_background: true` so the server stays alive while the user reviews. krit writes a state file at `$KRIT_STATE_FILE`, falling back to `$CLAUDE_TMPDIR/krit-state.json`, so the other subcommands auto-discover it.

**Always pass `dangerouslyDisableSandbox: true` on this Bash call.** krit hands the review to the UI via a spawned `open` (browser tab, or a `krit://` deep link when `launcher: "app"` is set in `~/.config/krit/settings.json`); the Claude Bash sandbox blocks that child even though `krit` itself would run fine, and the window silently fails to open.

`krit` automatically opens the UI (desktop-app window or browser tab per settings). Once open, the server sits idle waiting for the user to leave inline comments — it is **not** doing any work in the background and will not proceed on its own. If no UI ever connects, the server exits itself after 3 minutes.

## Step 2: Stream comment events (Monitor on the ws endpoint)

Read the server URL from the state file, then attach a **Monitor task** with a `ws` source:

```bash
krit state    # prints JSON incl. "url": "http://127.0.0.1:<port>"
```

Monitor with `ws: {url: "ws://localhost:<port>/api/events-ws"}` (use `localhost`, not `127.0.0.1` — sandbox host allowlists accept only the name). Each incoming text frame is one JSON event.

The agent stream is **human-only**: the server filters out echoes of your own work (`file-changed` from the fs-watcher, your own `krit refresh`, `comment-updated` re-anchor fallout). Because `comment-updated` is filtered, comment line positions in your context can go stale after files change — run `krit comments` to get current positions before acting on a comment you received a while ago. Frames you will see:

```json
{"type":"comment-added","comment":{"id":"...","filePath":"...","lineNumber":42,"endLine":42,"body":"...", ...}}
{"type":"reply-added","commentId":"...","reply":{"id":"...","body":"...","author":"user","createdAt":...},"commentStatus":"open"}
{"type":"user-edit","action":"delete","filePath":"...","range":{"startLine":10,"startColumn":0,"endLine":10,"endColumn":4},"deletedText":"..."}
{"type":"file-written","path":"..."}
{"type":"clients","browsers":2}
{"type":"submitted","timestamp":...}
{"type":"review-ended","reason":"idle"}
```

- `clients` is presence: `browsers` counts UI event subscriptions, and the UI opens two per tab — so one open tab reports `browsers: 2`, zero means the user closed the UI. Informational; no action needed.
- `user-edit` / `file-written` mean the user edited a file through the krit in-browser editor. Treat the file as changed on disk (re-Read before editing it yourself).
- Comments carry both `lineNumber` (start) and `endLine` (inclusive end). When the user drag-selected a range, `endLine > lineNumber` and `lineContent` contains the selected lines joined with `\n`. Treat the range as the scope of the comment.
- Replies carry `author: 'user' | 'agent'`. You only see `reply-added` for `author: 'user'` (your own CLI replies are suppressed). `commentStatus` is the post-event status of the parent — if the user replied to a comment you'd already resolved, the server auto-reopens it and `commentStatus` is `"open"`.

Attaching also lights up the **Done reviewing** button in the UI — with no agent subscriber attached, the button greys out and the user falls back to "Copy comments."

## Step 3: Hand off and end the turn

Tell the user — in your own words — that:

- A review window (desktop app or browser tab, per their settings) has been opened with the diff (mention it explicitly; the user may have the terminal focused and miss it).
- The krit server is now **waiting for them** to leave inline comments. You'll process each one as it arrives. Click **Done reviewing** when finished.

Keep it brief, but make those two points clear. Then END THE TURN. The Monitor will wake you when an event arrives.

## Step 4 (on each wake-up): Handle one event

Read the new frame(s) from the Monitor. For each:

- **`comment-added`** — read `comment.filePath`/`lineNumber`/`body`. Decide what it is:
  - **Change request** ("rename x", "extract helper", "use Map here") → Read the file, apply the change via Edit, then:
    ```bash
    krit refresh
    krit reply <id> "Done. <one-line summary of what changed>"
    krit resolve <id>
    ```
    `krit refresh` tells the open UI to refetch the diff so the edit shows up immediately — Edit-tool writes don't go through krit's own file-write path. (The fs-watcher usually catches the change too, but `krit refresh` is the guarantee.)
  - **Question** ("why not X?", "is this thread-safe?") → answer in reply. If confident the answer fully addresses it, also `krit resolve <id>`. If it might prompt follow-up, leave it open.
    ```bash
    krit reply <id> "<your answer>"
    ```
  - **Ambiguous** → reply asking for clarification, leave open.

- **`reply-added`** — the user replied to one of your earlier replies (probably pushback or follow-up). Read the reply, treat it like a new request scoped to that comment, and respond the same way.

- **`user-edit` / `file-written`** — the user changed a file via the krit editor. Usually no response needed; just don't clobber it — re-Read before your next Edit to that file.

- **`submitted`** — the user clicked Done reviewing. This is **not** the end of the session — they can still leave more comments or reply to yours. Acknowledge briefly and end the turn. Do not summarize or wrap up yet; that happens in Step 5.

End the turn after handling the event(s). The Monitor will wake you again on the next one.

## Step 5: Wrap up (when the stream ends)

The krit server shuts itself down 60s after the last UI subscriber disconnects (or 3 minutes if none ever connected). On shutdown it broadcasts `review-ended` and closes the WebSocket, which ends the Monitor:

- **`review-ended` then close, with a `submitted` seen earlier** — normal completion. Summarize briefly: N applied, M answered, K left open (and why).
- **`review-ended` with no `submitted`** — the user closed the UI without clicking Done. Tell the user and stop; don't silently re-launch.
- **Socket close with no `review-ended`** — krit crashed or was killed. Say so. The v1 fallback is available: same workflow via the `diffx` skill.

## Other subcommands

```bash
krit comments [open|resolved|replied|all]   # dump comments as JSON (no arg = all)
krit reopen <id>                        # flip a resolved comment back to open
krit wait-for-submit                    # batch alternative: block until Done reviewing (exit 0) or disconnect (exit 2)
```

## Manual fallback

If the streaming flow isn't usable (no Monitor attached, UI-only session), the user can click **Copy** in the UI to grab all comments as XML and paste them in. Process them via the same `krit comments open` / `reply` / `resolve` plumbing.
