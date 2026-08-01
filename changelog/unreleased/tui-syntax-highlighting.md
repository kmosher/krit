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
