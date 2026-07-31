# krit in the terminal

> **Status: phases 0 and 1 are built** (`krit-tui/`) — it reads a review and
> comments on one. Phases 2 and 3 are the ones worth committing to next, and 4
> and 5 are sketched to show where the seams are, not because they should be
> scheduled.

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
| Hunk expansion | Done — `fileContents` carries both sides per file |
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
is a workflow. Hence `m`, and hence releasing capture on *every* exit, not just
the tidy one: a terminal left reporting mouse events writes escape sequences
into the next shell prompt every time the pointer moves, so the panic hook
disables it unconditionally rather than consulting any state. Prefer OSC 52 for
clipboard writes over shelling out to `pbcopy`/`wl-copy`: OSC 52 works through
tmux and over SSH, which is exactly where a terminal review tool gets used.

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

Two things about suspend that only show up once it is wired: **Ctrl+Z is not a
signal** (raw mode clears `ISIG`, so it arrives as a key and the `kill -TSTP`
path is separate and also needed), and **`Terminal::clear()` is not free** —
it snapshots the cursor first, which is a `ESC[6n` round-trip that blocks
until the terminal answers. On resume that is a position about to be
overwritten anyway, so the repaint is a `Clear(All)` plus a fresh `Terminal`;
nothing in the resume path should be able to hang waiting for a reply.

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

**Phase 0 — read-only viewer. Done.** Adopts a running server via the state
file — or starts one, forwarding anything after `--` as its git diff range, so
`krit-tui` is a single command in a single shell. `GET /api/diff`, a unified
diff with a file list, navigation by line, page, file and hunk, folding, and
SSE for live updates. Mouse capture came with it (wheel scrolls without moving
the cursor, click moves it, `m` hands the mouse back to the terminal), and
`f` hides the file list. It reads the reviewer's `staged`/`untracked`/tab-width
settings and sends the first two to `/api/diff` — the route defaults them to
`false`, so a client that omits them shows only unstaged work. The row model, width handling, virtualization and
terminal setup/teardown are the part that carried the risk, and they are the
part that landed.

A server it started is not killed on exit: the idle timeout already counts
subscribers, so it goes away by itself a few seconds later — and killing it
would be wrong anyway if a browser tab is also attached.

One thing the sketch above assumes that is not there: the file pane is a flat
list, not a tree. Grouping by directory belongs with the rest of the phase-2
polish, not before anything else works.

**Going to a file tops it; walking scrolls minimally.** Least-movement
scrolling is right for a cursor moving a row at a time and wrong for a jump —
it lands the file header on the *last* visible row, so arriving at a file means
looking at the end of the previous one. `]`/`[` and a click in the file list
put the header on the first row instead; hunk jumps keep the minimal behavior,
since consecutive hunks are usually already on screen and re-topping each one
makes `n` lurch.

**Phase 1 — commenting. Done.** The TUI is a review client: `v` selects lines
(every movement key extends it), a drag selects characters, `c` opens the
composer, and `R`/`X`/`P`/`S` reply, resolve, post queued and finish. Comments
render as annotation rows interleaved into the row model, `}`/`{` step between
them, and the badge line says the state in words.

The column really does come free: `selectionMapping.ts` is 400 lines of
caret-from-point hit-testing to recover what a terminal puts in the mouse
event. What it costs instead is a *conversion*, because the two clients have to
agree on what a column is — the wire counts UTF-16 units into the source line
(the browser measures `Range.toString().length`), the screen counts cells, and
a tab is one of the first and four of the second. `text::cluster_at_column` is
that conversion, and the one place the two clients deliberately differ is which
end is included: a browser endpoint is an insertion point between characters, a
terminal endpoint is a *cell*, so the character under the pointer is in the
selection.

Three things are deliberately not in it:

- **Character-level selection from the keyboard.** `v` is line-wise, which is
  the shape a line comment already has on the wire. A caret that moves along a
  line is a second cursor to draw, move and scroll, and the mouse covers the
  case it would serve.
- **Suggestions.** The `suggestion` field is a second editor seeded from the
  file, plus the stored `suggestionEdited` bit and everything that hangs off it
  (see `CLAUDE.md`). None of that is here; a suggestion posted from the browser
  renders as a comment whose badge says `suggestion`.
- **Editing a queued comment**, which the browser allows through the badge.

**A write asks for its own refetch.** Two of the mutations broadcast nothing at
all — a queued comment is suppressed from every broadcast until it is posted,
and `PUT /api/comments/{id}` announces only the catch-up when a queued one goes
open. A client that only listened would show queueing and resolving as keys
that do nothing. The browser is covered by its comment poll; the TUI asks.

**Pending drafts are still on the table and not wired.** `/api/pending-drafts`
exists and the composer could hydrate from it, which is worth having in a pane
that gets closed and reopened. Two clients on one slot is last-writer-wins, so
a TUI and a browser open on the same review would not see each other type.

**Phase 2 — parity polish.** In progress. Hunk expansion is **done**: the gaps
between hunks open a few lines at a time from both edges (`+` / `-`, `z` for all
of it), out of the `fileContents` every diff response already carries. Still to
do: split view with the narrow-terminal fallback, syntax highlighting, viewed
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
- ~~**Drafts do not survive a client restart.**~~ Closed server-side: unsent
  comment text persists through `/api/pending-drafts`. The TUI does not use it
  yet — see the note under phase 1.
- ~~**A resolve is invisible to the other client for as long as its poll
  takes.**~~ Closed. `PUT /api/comments/{id}` now broadcasts `comment-updated`,
  and the reply route broadcasts whatever its source — the agent's own reply is
  filtered out of the agent stream in `agent_visible` rather than never sent,
  which is what had made an agent's entire half of the conversation invisible in
  the terminal. This was also the prerequisite `CLAUDE.md` named for making open
  comments editable; that is now one change away rather than two.
- **`DELETE /api/comments/{id}` still broadcasts nothing.** A comment deleted in
  the browser stays on the TUI's screen, and `R` or `X` on it 404s. The TUI
  refetches on a refused write, so it corrects itself on the first attempt to
  use one — but a `comment-deleted` event is the honest fix, and it is the last
  mutation with no announcement that is not silent on purpose.
- **The SSE stream carries everything, deliberately.** Unlike
  `/api/events-ws`, `/api/events` does not filter `files-changed` or reanchor
  fallout (`server.rs`, `agent_visible`). That is correct for the TUI — it is a
  human's client — but it means the TUI must debounce, not the server.
