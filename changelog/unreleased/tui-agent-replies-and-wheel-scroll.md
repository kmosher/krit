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
