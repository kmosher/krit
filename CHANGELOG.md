# Changelog

Released versions only. **An unreleased change goes in `changelog/unreleased/`
as its own file** — see `changelog/README.md`. Editing this file by hand is how
two agents landing in the same hour collide in a file whose contents neither of
them disagrees about.

`just changelog` previews what the next release will say; `just release <ver>`
is the only thing that writes below this line.

krit is `0.x`. Breaking changes appear under **Changed** like anything else —
see the warning at the top of the README.

<!-- releases below -->

## 0.10.0 — 2026-07-31

### Added

- `krit-tui` highlights syntax. Whole files are parsed rather than hunks, out
  of the text `/api/diff` already bundles, so a hunk that opens inside a block
  comment is not coloured as code. `KRIT_THEME` picks any of two-face's
  themes (`ansi` paints in the terminal's own palette, which is the one that
  cannot clash with a light background); `NO_COLOR` and a terminal with no
  truecolor or 256-colour support degrade rather than disappear.
- `t` toggles background tints on added and removed lines. On by default —
  with syntax owning the foreground, the `+`/`-` marker was carrying the whole
  distinction on its own.


## 0.9.0 — 2026-07-31

### Changed

- `krit-tui`'s composer submits on `Enter`, matching the web UI. `Shift+Enter`
  and `Option+Enter` insert a newline where the terminal can deliver them, and
  `Ctrl+J` does everywhere — it is the one that needs no keyboard protocol, so
  it is what the footer names on a terminal that cannot report the other two.
  `Ctrl+S` still posts and `Ctrl+Q` still queues; `Option+Enter` no longer
  queues.

### Fixed

- Scrolling a diff with a trackpad no longer slides the code out of
  `krit-tui`'s pane. A two-finger swipe reports a sideways component the whole
  way down, and acting on each notch left a screen of line numbers and `+`/`-`
  markers with no code beside them. Sideways scrolling by wheel now needs a run
  of horizontal notches, and the footer names the column whenever the pane is
  scrolled off zero.


## 0.8.1 — 2026-07-31

### Changed

- `CLAUDE.md`: the shadow-root readback trap is scoped correctly — every
  `render*` callback's output is slotted light DOM, not just annotations, so a
  file header read back through `shadowRoot.textContent` omits krit's additions
  to it entirely.


## 0.8.0 — 2026-07-31

### Added

- `krit-tui`: tick a file off with `V`. It writes the same `/api/viewed` state
  the browser's Viewed checkbox does, so a file marked in one client is marked
  in the other — and, like the browser, a ticked file keeps its header and loses
  its body. The list shows a `✓` rather than a color, so it survives `NO_COLOR`.
  `v` alone still starts visual mode; `V` was a synonym for it, since the
  selection is already line-wise.

### Changed

- `krit-tui`: `V` no longer starts visual mode. Use `v`.


## 0.7.1 — 2026-07-31

### Fixed

- The web UI now shows a file's permission change (`100644 → 100755`) in its
  header. A `chmod` is the one change git reports with no hunks, so such a file
  previously rendered with nothing on screen explaining why it was in the
  review at all. `krit-tui` already reported this.


## 0.7.0 — 2026-07-31

### Added

- `krit-tui`: a file whose only change is its mode says so — `mode 100644 →
  100755` under the header. `chmod +x` produces a diff with no hunks at all, so
  such a file used to render `+0 −0` with nothing anywhere explaining why it was
  in the review. (The web UI still does; that is filed separately.)

### Fixed

- `krit-tui`: the file list scrolls. The wheel now goes to whichever pane the
  pointer is over — it used to scroll the diff wherever it was pointed — and the
  list has a position of its own rather than one recomputed from the cursor
  every frame, which no scroll could move. A review with more files than rows
  had no way to show the rest short of walking the cursor into them.


## 0.6.3 — 2026-07-31

### Changed

- The long-line cap now records what was measured rather than a mechanism. The
  displacement is real and reproduces with the cap lifted; the explanation
  previously given for it — a wrong virtualizer height estimate for the wrapped
  run — is not, and a standalone CodeView does not displace at either length.


## 0.6.2 — 2026-07-31

### Fixed

- `krit-tui`: split view's divider now sits in a fixed column. Each side is
  padded to its half rather than merely truncated to it, so the two code columns
  line up instead of the divider landing wherever a line happened to end — and,
  because that column is also what decides which side a click was in, a
  character drag in the right-hand column no longer resolves against the
  left-hand line.
- `krit-tui`: the `diffStyle` setting is honoured again. It was parsed and then
  never applied, so the terminal opened side-by-side regardless of what the
  reviewer had chosen in the browser.
- `krit-tui`: a drag that wanders past the divider extends to the end of the
  line it started on, instead of restarting in the other column's coordinates
  and reversing the stored range or collapsing it into a click.
- `krit-tui`: a press on a row with no sides — a header, a comment, a gap — no
  longer invents one from whichever half of the pane it landed in. Over an
  addition-only run the invented side left nothing to anchor to, so `c` did
  nothing at all.
- `krit-tui`: toggling between split and unified keeps the cursor on the same
  line of code, and an implicit flip (hiding the file list across the width
  threshold) drops a selection whose rows and columns belong to the other view.
- `krit-tui`: a comment on an unchanged line inside a hunk renders once in split
  view rather than twice.
- `krit-tui`: a file with no new side — deleted, or emptied in place — no longer
  claims one unchanged line it cannot show. That row was also the only way to
  reach a zero line number, which underflowed.
- `krit-tui`: a file whose text arrives in a shape this client does not
  recognise still gets its `⋯` rows, saying the text is unavailable, rather than
  silently having no hidden context at all.


## 0.6.1 — 2026-07-31

### Fixed

- A file containing a very long line no longer displaces or blanks the whole
  diff surface. Such files are withheld from the surface and named in a strip
  above it, rather than taking every other file down with them.
- A renderer that throws is now contained to its own preview pane, instead of
  unmounting the entire review.
- Deeply nested SVG is truncated at a fixed depth and says so, rather than
  exhausting the stack while it is being sanitized.


## 0.6.0 — 2026-07-31

### Added

- `krit-tui`: side-by-side diffs. A deleted line and the line that replaced it
  sit on the same row, separated by a divider, and a character drag in either
  column comments on that column's line — the two are different lines with
  different numbers, so which one you dragged in is what decides. `s` toggles;
  the starting view comes from the shared `diffStyle` setting, so the terminal
  opens the way the browser does. Below a 90-column *diff pane* it falls back to
  unified and remembers the preference, which means hiding the file list (`f`)
  is enough to get split view back on a narrow terminal.


## 0.5.1 — 2026-07-31

### Fixed

- Marking a file viewed while the viewed-list request was still in flight no
  longer un-ticks itself. The optimistic write went into react-query's cache
  and the outstanding load then installed its own, older list over it — with a
  `PUT` that had succeeded and nothing on screen to say the tick was gone. The
  window is every page still loading its first list, which is exactly when a
  reviewer starts marking files off.


## 0.5.0 — 2026-07-31

### Added

- `krit-tui`: the unchanged lines between hunks can be opened. A `⋯ N unchanged
  lines` row stands in for each run; `+` opens a few from each edge, `-` closes
  them again, and `z` opens or folds the whole run — the same key that folds a
  file, one level down. The text comes from the `fileContents` every `/api/diff`
  response already carries, so nothing new is fetched. A file too large or too
  binary to send says so on the row rather than leaving a key that does nothing.


## 0.4.0 — 2026-07-31

### Fixed

- An agent's replies and resolves now reach every client. `POST /api/comments/{id}/replies`
  broadcast only for `?source=ui`, and `PUT /api/comments/{id}` broadcast only the
  queued-comment catch-up, so a client that listens rather than polls never learned the
  agent had answered. The agent still does not hear its own replies — that suppression
  moved from the route to the agent stream's filter, where it belongs.
- `krit-tui`: the mouse wheel scrolls again. Pane reconciliation ran after every draw and
  pulled the view back to the cursor, so a wheel notch lasted exactly one frame. Opening
  the help overlay no longer loses your place either.
- `krit-tui`: a drag that ends below and to the left of where it started, on a selection
  that collapses to one line, no longer stores `startColumn` past `endColumn`.
- `krit-tui`: a comment on a file carrying both staged and unstaged changes anchors in the
  section it was written on, rather than always the staged one.
- `krit-tui`: the marked range survives a comment arriving above it, and is dropped when
  the diff itself changes — previously it kept stale row indices and `c` could post
  against lines the reviewer never selected.
- `krit-tui`: `Ctrl+C` in the composer asks the discard question instead of doing nothing,
  and an answer to a form the reviewer has already left can no longer close the one they
  are typing in now.
- `krit-tui`: comments on files outside the review are counted in the header
  (`3 comments (1 elsewhere)`) rather than counted and then rendered nowhere.


## 0.3.0 — 2026-07-31

### Added

- Changelog fragments (`changelog/unreleased/`, one file per change) plus
  `just changelog` and `just release <version>`. Several agents work this repo
  concurrently and land in arbitrary order; a shared `CHANGELOG.md` made every
  one after the first fold into a conflict. `just release` also sets all three
  version files together, so they can no longer drift apart.
- The web UI says when the server is gone. A dismissible banner distinguishes a
  finished review from a killed backend from a transient reconnect, so a page
  that can no longer save anything says so instead of showing a load-failure
  strip indistinguishable from a 500.
- `review-ended` is broadcast on SIGTERM/SIGINT too, carrying a typed
  `EndReason` — a killed server says goodbye rather than vanishing.

### Changed

- `just release` takes `patch` (the default) or `minor` and derives the number
  itself, rather than being told one. Releases now happen on every fold, so the
  version is picked many times a day and the two available typos — reusing the
  current version, skipping one — both reach three files before anything
  notices. It also refuses to run on a branch behind `origin/main`, and
  `CHANGELOG.md` is `merge=union`, which together keep concurrent releases from
  colliding.
- Versioning moved from `2.0.0` to `0.2.0`. The `2` was product identity (krit
  is diffx v2), which is not the same claim as a stable major.

