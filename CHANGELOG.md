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

