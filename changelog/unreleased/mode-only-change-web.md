### Fixed

- The web UI now shows a file's permission change (`100644 → 100755`) in its
  header. A `chmod` is the one change git reports with no hunks, so such a file
  previously rendered with nothing on screen explaining why it was in the
  review at all. `krit-tui` already reported this.
