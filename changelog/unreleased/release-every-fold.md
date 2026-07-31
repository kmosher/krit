### Changed

- `just release` takes `patch` (the default) or `minor` and derives the number
  itself, rather than being told one. Releases now happen on every fold, so the
  version is picked many times a day and the two available typos — reusing the
  current version, skipping one — both reach three files before anything
  notices. It also refuses to run on a branch behind `origin/main`, and
  `CHANGELOG.md` is `merge=union`, which together keep concurrent releases from
  colliding.
