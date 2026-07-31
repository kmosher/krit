### Added

- `krit-tui`: side-by-side diffs. A deleted line and the line that replaced it
  sit on the same row, separated by a divider, and a character drag in either
  column comments on that column's line — the two are different lines with
  different numbers, so which one you dragged in is what decides. `s` toggles;
  the starting view comes from the shared `diffStyle` setting, so the terminal
  opens the way the browser does. Below a 90-column *diff pane* it falls back to
  unified and remembers the preference, which means hiding the file list (`f`)
  is enough to get split view back on a narrow terminal.
