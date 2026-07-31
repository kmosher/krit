### Added

- `krit-tui`: the unchanged lines between hunks can be opened. A `⋯ N unchanged
  lines` row stands in for each run; `+` opens a few from each edge, `-` closes
  them again, and `z` opens or folds the whole run — the same key that folds a
  file, one level down. The text comes from the `fileContents` every `/api/diff`
  response already carries, so nothing new is fetched. A file too large or too
  binary to send says so on the row rather than leaving a key that does nothing.
