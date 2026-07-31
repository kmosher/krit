# Changelog

Released versions only. **An unreleased change goes in `changelog/unreleased/`
as its own file** — see `changelog/README.md`. Editing this file by hand is how
two agents landing in the same hour collide in a file whose contents neither of
them disagrees about.

`just changelog` previews what the next release will say; `just release <ver>`
is the only thing that writes below this line.

krit is `0.x`. Breaking changes appear under **Changed** like anything else —
see the warning at the top of the README.

<!-- releases below -->

## 0.3.0 — 2026-07-31

### Added

- Changelog fragments (`changelog/unreleased/`, one file per change) plus
  `just changelog` and `just release <version>`. Several agents work this repo
  concurrently and land in arbitrary order; a shared `CHANGELOG.md` made every
  one after the first fold into a conflict. `just release` also sets all three
  version files together, so they can no longer drift apart.
- The web UI says when the server is gone. A dismissible banner distinguishes a
  finished review from a killed backend from a transient reconnect, so a page
  that can no longer save anything says so instead of showing a load-failure
  strip indistinguishable from a 500.
- `review-ended` is broadcast on SIGTERM/SIGINT too, carrying a typed
  `EndReason` — a killed server says goodbye rather than vanishing.

### Changed

- `just release` takes `patch` (the default) or `minor` and derives the number
  itself, rather than being told one. Releases now happen on every fold, so the
  version is picked many times a day and the two available typos — reusing the
  current version, skipping one — both reach three files before anything
  notices. It also refuses to run on a branch behind `origin/main`, and
  `CHANGELOG.md` is `merge=union`, which together keep concurrent releases from
  colliding.
- Versioning moved from `2.0.0` to `0.2.0`. The `2` was product identity (krit
  is diffx v2), which is not the same claim as a stable major.

