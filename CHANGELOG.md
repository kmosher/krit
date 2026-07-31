# Changelog

Hand-written, newest first, in the [Keep a Changelog](https://keepachangelog.com)
shape. There is no fragment directory and no batching tool: those exist to keep
concurrent pull requests from conflicting on this file, which is not a problem
krit has. Add your entry to `## Unreleased` in the same commit as the change,
and rename that heading when you cut a version.

krit is `0.x`. Breaking changes land in minor bumps and are listed under
**Changed** like anything else — see the warning at the top of the README.

## Unreleased

### Added

- The web UI now tells you when the server is gone. A dismissible banner
  distinguishes a finished review from a crashed backend from a transient
  reconnect, so a page that can no longer save anything says so instead of
  emitting a load-failure toast.
- `review-ended` is now broadcast on SIGTERM/SIGINT as well, with
  `reason: "signal"` — a killed server says goodbye rather than vanishing.

### Changed

- Versioning moved from `2.0.0` to `0.2.0`. The `2` was product identity
  (krit is diffx v2), which is not the same claim as a stable major.
