### Fixed

- `krit-tui`: the file list scrolls. The wheel now goes to whichever pane the
  pointer is over — it used to scroll the diff wherever it was pointed — and the
  list has a position of its own rather than one recomputed from the cursor
  every frame, which no scroll could move. A review with more files than rows
  had no way to show the rest short of walking the cursor into them.

### Added

- `krit-tui`: a file whose only change is its mode says so — `mode 100644 →
  100755` under the header. `chmod +x` produces a diff with no hunks at all, so
  such a file used to render `+0 −0` with nothing anywhere explaining why it was
  in the review. (The web UI still does; that is filed separately.)
