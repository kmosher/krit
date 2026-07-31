### Changed

- `krit-tui`'s composer submits on `Enter`, matching the web UI. `Shift+Enter`
  and `Option+Enter` insert a newline where the terminal can deliver them, and
  `Ctrl+J` does everywhere — it is the one that needs no keyboard protocol, so
  it is what the footer names on a terminal that cannot report the other two.
  `Ctrl+S` still posts and `Ctrl+Q` still queues; `Option+Enter` no longer
  queues.
