### Added

- `krit-tui`: tick a file off with `V`. It writes the same `/api/viewed` state
  the browser's Viewed checkbox does, so a file marked in one client is marked
  in the other — and, like the browser, a ticked file keeps its header and loses
  its body. The list shows a `✓` rather than a color, so it survives `NO_COLOR`.

  `v` alone still starts visual mode; `V` was a synonym for it, since the
  selection is already line-wise.

### Changed

- `krit-tui`: `V` no longer starts visual mode. Use `v`.
