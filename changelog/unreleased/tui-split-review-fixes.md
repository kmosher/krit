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
