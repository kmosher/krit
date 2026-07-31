### Added

- The web UI says when the server is gone. A dismissible banner distinguishes a
  finished review from a killed backend from a transient reconnect, so a page
  that can no longer save anything says so instead of showing a load-failure
  strip indistinguishable from a 500.
- `review-ended` is broadcast on SIGTERM/SIGINT too, carrying a typed
  `EndReason` — a killed server says goodbye rather than vanishing.
