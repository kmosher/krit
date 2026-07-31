# Changelog fragments

One file per change, in `unreleased/`. **Never edit `CHANGELOG.md` directly**
for an unreleased change — that file is the merge conflict this directory
exists to avoid.

Several agents work this repo at once, each in its own worktree, and they land
by `wt-fold` in whatever order they finish. Appending to a shared list means
every one of them writes the same lines of the same file, so the second to fold
gets a conflict in a file whose content nobody actually disagrees about. A new
file per change cannot collide.

## Writing one

```
changelog/unreleased/<short-slug>.md
```

The body is the changelog entry in its final form — a category heading and one
or more bullets:

```markdown
### Fixed

- The comment poll no longer freezes while the tab reports itself hidden.
```

Categories are [Keep a Changelog](https://keepachangelog.com)'s: `Added`,
`Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. At `0.x` a breaking
change is `Changed` like anything else.

Write it in the same commit as the change. Slug the filename after the change,
not after the branch or the date — two agents picking the same date prefix is
the collision this is meant to prevent, and a duplicate slug means two people
described the same change, which is worth noticing.

## Releasing

Every fold, as the last commit before `wt-fold`:

```
just changelog          # preview the collated section
just release            # next patch
just release minor      # next minor — a user-visible change, or one that moves the wire
just release 0.9.0      # an explicit version, when neither is right
```

`just release` is the only thing that writes `CHANGELOG.md` or a version
number, and it is the only thing that should. It refuses on a branch behind
`origin/main`, because the next version is derived from the current one and a
stale branch derives the wrong answer.
