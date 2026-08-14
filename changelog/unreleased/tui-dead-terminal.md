### Fixed

- `krit-tui` exits when its terminal goes away instead of spinning a core
  forever. Closing the far end of a pty — a killed tmux session, a closed
  terminal window — left the viewer in a wait that never returns, and because
  the draw loop is where signals are answered, the orphan survived SIGTERM and
  SIGHUP and needed SIGKILL.
