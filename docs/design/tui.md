# krit in the terminal

> **Status: design only.** Nothing below is built. Phases 0–3 are the ones
> worth committing to; 4 and 5 are sketched to show where the seams are, not
> because they should be scheduled.

A second client for the same server, so a review can happen in the pane beside
the agent instead of in a browser. The end state is a `krit-tui` binary that
also runs as a [herdr](https://herdr.dev) plugin pane, but it must work
standalone first — the herdr half is packaging, not architecture.

## Why this is cheap, and where it isn't

The server already owns the whole review model: diff assembly, the comment
store, reanchoring across edits (`reanchor.rs`), inline edits with content-tag
handshakes, queueing, drafts, submit gating, and the SSE fan-out. `src/ui/` is a client,
not the app. A TUI is a second client over `/api/diff` + `/api/comments` +
`/api/events`, and nothing it needs lives in the browser.

Two existing choices pay off immediately:

- **Server discovery is solved.** `state.rs` resolves a running server from a
  state file (`$KRIT_STATE_FILE`, then `$CLAUDE_TMPDIR`, then `~/.krit/`), and
  `subcommands.rs` already has "find the server or diagnose and exit". The TUI
  adopts a running review or spawns one; it does not need its own protocol.
- **The server shells out to git.** The TUI needs no git of its own, which
  matters more than it sounds — see the herdr `PATH` constraint below.

What is *not* cheap is everything Pierre CodeView does today. The row model,
syntax highlighting, hunk expansion, and the annotation rows that make krit
feel like a review tool rather than a pager all get rebuilt. The one consolation
is that the hardest part of the web UI gets easier, not harder: krit resolves
comment anchors to character columns, and `@pierre/diffs` only ever exposes
`{lineNumber, side}`, so `selectionMapping.ts` derives columns by hit-testing
points against the DOM. A terminal hands you `(row, column)` in the mouse event.
The work that took a week of WebKit archaeology is a struct field here.

## What the terminal has to earn back

Feature parity with the web UI, roughly in order of how much of the experience
they carry:

| Web UI | Terminal |
| --- | --- |
| Split / unified diff | Both; auto-fall-back to unified under ~120 columns |
| Syntax highlighting | `syntect` + `two-face`'s bundled themes |
| Hunk expansion | Already served: `fileContents` carries both sides per file |
| File tree with change-type icons | Distinct ASCII sigils, not just color |
| Character-range comments | Free from mouse coords; visual mode for keyboard |
| Comment / reply / resolve / queue | Plain API calls |
| Annotation rows inline in the diff | Interleaved rows in the row model |
| Live refresh (SSE) | Same stream — it carries everything |
| Inline editing (CodeMirror) | Phase 4, and the least certain part of this doc |
| Strip stack for conflicts and errors | Same idea, bottom rows |

## Terminal techniques worth naming

Most of these are not optional polish; each one is a way the naive version is
visibly wrong.

**Grapheme-correct widths.** `unicode-width` for display width and
`unicode-segmentation` for cluster boundaries. CJK is double-width, emoji ZWJ
sequences are one cluster of many code points, and combining marks are zero
width. A diff of real source will contain all three, and a column count that
assumes `char == cell` puts the caret in the wrong place and corrupts the
right-hand pane of a split view. Tabs expand per the existing `defaultTabSize`
setting. RTL and bidi reordering are explicitly out of scope — state it in the
README rather than half-supporting it.

**Bracketed paste.** Crossterm reports it as one event when enabled. Without
it, pasting a three-line comment into the composer sends three `Enter`s, which
submits after the first line and leaves two lines rattling around in whatever
had focus next. This is the single most likely "obviously broken on day one"
bug in the whole design.

**Keyboard disambiguation.** The web UI uses `Cmd+Enter` to submit a comment
and `Shift+Enter` for a newline. A legacy terminal cannot distinguish either
from plain `Enter` — they all arrive as `\r`. The Kitty keyboard protocol
(`PushKeyboardEnhancementFlags` with
`DISAMBIGUATE_ESCAPE_CODES | REPORT_ALL_KEYS_AS_ESCAPE_CODES`) fixes it where
supported (kitty, foot, WezTerm, Ghostty, recent iTerm2). Where it isn't,
`Enter` inserts a newline and `Ctrl+S` submits, and the footer says which mode
is live. Do not pick the binding based on the developer's terminal.

**Mouse capture, and giving it back.** `EnableMouseCapture` buys click-to-focus,
click-drag selection, and scroll. It also takes over the terminal's own
selection, so the user loses native copy — a real cost, since copy-the-comment
is a workflow. Bind a key to toggle capture off, and prefer OSC 52 for clipboard
writes over shelling out to `pbcopy`/`wl-copy`: OSC 52 works through tmux and
over SSH, which is exactly where a terminal review tool gets used.

**A cached row model, virtualized.** Build the visible window only. The web UI
already learned this (`computeRowWindow`, `useVirtualRows`) and the reason is
the same, but the cost profile differs: ratatui diffs its own back buffer and
emits only changed cells, so *drawing* is nearly free and the expense is
*building* rows — highlighting, wrapping, interleaving annotations. Cache per
file, keyed the way `App.cacheKey` is, and invalidate on the same signals.

**Terminal capability, downward.** Truecolor via `COLORTERM`, with a real 256
and 8-color path rather than reviewr's "truecolor required". Honor `NO_COLOR`.
Every state that means something must survive losing color: `+`/`-` sigils on
stats, distinct glyphs per change type (mirroring `getFileIcon`'s use of
different icon *shapes*, not different colors), and text labels on resolved and
outdated rather than a green or amber dot.

**Restore the terminal, always.** Raw mode, the alternate screen, mouse capture,
and the keyboard flags are all global terminal state. A panic that skips the
teardown leaves the user with a shell that does not echo. `std::panic::set_hook`
chained to a `Drop` guard, plus `SIGTSTP`/`SIGCONT` handling so `Ctrl+Z` and
`fg` come back intact.

**Focus events, and the lesson not to repeat.** `EnableFocusChange` maps onto
`refreshMode: live-unless-active`. But note what the web UI learned the hard
way: the comment poll had to set `refetchIntervalInBackground` because an
automated browser reports itself hidden the entire time it drives krit, and the
default froze the list with no error. The TUI inherits the good version of this
by accident — it reads SSE, not a poll — so the rule to carry over is the
general one: **never gate a data path on focus.** Use focus for rendering
decisions only.

**No blocking prompts. Ever.** `CLAUDE.md`'s ban on `confirm()`/`alert()` is
about krit being driven programmatically: an agent that hits a modal deadlocks.
The terminal equivalent is a prompt that waits on a keypress before the program
will do anything else. Every question — discard the draft, overwrite the
conflict, save anyway — is an inline strip with the rest of the UI still live
and still redrawing. The web UI funnels every exit from a form with unsaved work
through one function (`requestClose`, `requestCancel`) so a new exit path cannot
skip the question; do the same here from the start, because retrofitting it is
how the web UI got a test that globs the tree for `confirm`.

**OSC 8 hyperlinks** for file paths and any PR URL, in terminals that support
them. Cheap, and makes the file tree feel native.

**Snapshot tests.** ratatui's `TestBackend` renders into an inspectable cell
buffer, which is the direct analogue of the Vitest suite: pure row-model
functions tested directly, whole-frame snapshots for layout. The repo's existing
convention — keep the testable logic in exported pure functions — transfers
without change, and matters more here, because there is no `TestBackend`
equivalent for "did the selection land on the right grapheme".

## herdr, as a host

Verified against herdr 0.7.5 (its own docs, plus `herdr-reviewr`'s
`docs/herdr-api-notes.md`, whose author confirmed most of this live).

A plugin is a directory with a `herdr-plugin.toml` and argv commands herdr
launches — no SDK, any language. A `[[panes]]` entry names a command and a
placement (`split`, `tab`, and `zoomed` persist and support `pane.move`/
`resize`/`zoom`; `overlay` and `popup` do not). A Rust ratatui binary is exactly
the artifact it wants. The constraints that shape the design:

- **The pane's cwd is the repo under review, not the plugin root, and `PATH` is
  minimal.** Invoke the binary by absolute path under `$HERDR_PLUGIN_ROOT`. The
  `PATH` half is where krit gets a free win: because the server does the git
  work, the TUI needs no `git` on `PATH` at all.
- **No supervised daemons.** `[[startup]]` hooks are one-shot, and v1 has no
  runtime action registration and no managed storage. This would be the
  expensive constraint for a server-shaped tool, except the state-file discovery
  above already answers it: the pane adopts a running server or spawns one.
- **`plugin pane open` takes `--env KEY=VALUE`.** Not in reviewr's notes, and
  the cleanest way to hand a pane its review: `--env KRIT_STATE_FILE=…` pins
  which server that pane belongs to, which is what makes several concurrent
  reviews in one herdr session coherent.
- **Errors come back as JSON envelopes on stderr** —
  `{"error":{"code":"pane_not_found",…}}` — and the `message` names pane ids the
  user has never seen, so it is not displayable. But when the socket itself is
  missing, the CLI instead prints a raw Rust `Os { code: 2, … }`. Handle both
  shapes and show your own sentence.
- **`plugin action invoke` resolves context from the focused workspace**,
  ignoring the calling pane's environment.

### What herdr can and cannot tell us

The agent channel is `herdr pane send-text <pane> "<text>"`, which types into
the agent's input and does not even press Enter — reviewr follows it with
`agent focus` so the human submits. That is the whole interface. There is no
structured agent messaging and no turn API.

This matters for scoping, because it means the two integrations are independent:

- **krit's own channel** — the agent connects to `/api/events-ws` and gets
  structured comments, replies, resolve, and `agent_visible` filtering. This
  already exists and herdr contributes nothing to it.
- **herdr's channel** — `send-text` to whatever agent occupies the workspace.
  Works with any agent, lossy and one-way.

So the plugin's real value is pane placement plus resolving *which* agent
(`herdr agent list` → filter by `cwd` under the review's repo root), with
`send-text` as a fallback for agents that do not speak krit. A plugin that only
did `send-text` would be strictly worse than what krit does today.

Per-turn diff scoping is the one feature herdr makes *possible* rather than
easier, and it is genuinely unreliable: reviewr derives turn boundaries by
polling `agent list` and keeping its own baseline ref, and its own docs concede
that a turn starting and finishing inside one poll is missed, that the scope can
span several turns, and that several agents in one worktree pool their work. If
krit wants this, drive it from `pane.agent_status_changed` events and a baseline
ref under `refs/krit/`, and be honest in the UI about what the scope means.

## Phases

**Phase 0 — read-only viewer.** Adopt a running server via the state file (or
spawn one), `GET /api/diff`, render a unified diff with a file tree, navigate by
file and hunk, subscribe to SSE for live updates. No comments, no editing. This
is where the row model, width handling, virtualization, and terminal
setup/teardown get built, so it is most of the risk.

**Phase 1 — commenting.** Visual-mode and click-drag selection down to the
column, the composer (bracketed paste, keyboard disambiguation, the strip-stack
question on discard), then `POST /api/comments`, replies, resolve/reopen,
queueing, and `POST /api/submit`. At the end of this phase the TUI is a usable
review client.

**Phase 2 — parity polish.** Split view with the narrow-terminal fallback,
syntax highlighting, hunk expansion from the bundled `fileContents`, viewed
state via `/api/viewed`, the stale-file indicators, refresh modes, the
degraded-color paths.

**Phase 3 — herdr plugin.** `herdr-plugin.toml` with a `split` pane and
toggle/open/close actions, a `[[build]]` step, `--env KRIT_STATE_FILE`
threading, agent resolution from `agent list`, and `send-text` as the
non-krit-agent fallback. Nothing in phases 0–2 should need to change for this,
and if something does, that is the signal the host leaked into the core.

**Phase 4 — inline editing.** The risky one. CodeMirror parity in a terminal is
a text editor, and the honest options are to embed one (`edtui`, or a
CodeMirror-shaped minimal buffer of our own) or to shell out to `$EDITOR` and
re-read on exit. Shelling out is unglamorous and probably correct: it is what
`git commit` does, it inherits every user's real editor config, and it sidesteps
the whole class of bugs. The content-tag handshake and conflict strips are
already server-side, so either route reuses them.

**Phase 5 — per-turn scope.** Only with herdr, only with a baseline ref, and
only if the honesty problem above can be solved in the UI.

## Server gaps this will expose

- **`api_file_content_get` has no size cap.** `read_side` caps both bytes and
  lines, but the file-content route streams whatever it finds. A TUI that opens
  files directly (phase 4, or a whole-worktree browser) will hit this first.
- ~~**Drafts do not survive a client restart.**~~ Closed: unsent comment text
  now persists server-side through `/api/pending-drafts`, so the TUI gets it for
  free — hydrate the composer from that route on start and write on change. The
  route deliberately does not broadcast, so two clients on one slot is
  last-writer-wins; for phase 1 that is fine (one reviewer), but a TUI and a
  browser open on the same review will not see each other type.
- **The SSE stream carries everything, deliberately.** Unlike
  `/api/events-ws`, `/api/events` does not filter `files-changed` or reanchor
  fallout (`server.rs`, `agent_visible`). That is correct for the TUI — it is a
  human's client — but it means the TUI must debounce, not the server.
