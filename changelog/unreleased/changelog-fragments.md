### Added

- Changelog fragments (`changelog/unreleased/`, one file per change) plus
  `just changelog` and `just release <version>`. Several agents work this repo
  concurrently and land in arbitrary order; a shared `CHANGELOG.md` made every
  one after the first fold into a conflict. `just release` also sets all three
  version files together, so they can no longer drift apart.
