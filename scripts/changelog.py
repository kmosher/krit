#!/usr/bin/env python3
"""Collate changelog fragments, and cut a release.

See changelog/README.md for why fragments exist. This script is the only thing
that writes CHANGELOG.md, and the only thing that writes a version number: the
four files carrying one have to agree, and they are four separate merge
conflicts waiting to happen if each release edits them by hand.

    scripts/changelog.py collate            # print the merged section
    scripts/changelog.py release patch      # next patch: write CHANGELOG.md, drop fragments, bump
    scripts/changelog.py release minor      # next minor
    scripts/changelog.py release 0.9.0      # an explicit version, when neither is right
"""

from __future__ import annotations

import datetime
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FRAGMENTS = ROOT / "changelog" / "unreleased"
CHANGELOG = ROOT / "CHANGELOG.md"

# Keep a Changelog's order. Sections come out in this order regardless of the
# order fragments were written or read, so a release's shape doesn't depend on
# which agent folded first.
CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]


def read_fragments() -> dict[str, list[str]]:
    """Merge every fragment into {category: [bullet, ...]}.

    Bullets keep their source order within a fragment, and fragments are read
    in filename order — arbitrary, but stable, which is what matters for a
    file that gets reviewed in a diff.
    """
    sections: dict[str, list[str]] = {}
    if not FRAGMENTS.is_dir():
        return sections
    for path in sorted(FRAGMENTS.glob("*.md")):
        category: str | None = None
        for line in path.read_text().splitlines():
            heading = re.fullmatch(r"#{2,4}\s*(\w+)\s*", line)
            if heading:
                category = heading.group(1)
                if category not in CATEGORIES:
                    sys.exit(
                        f"{path.name}: '{category}' is not a changelog category. "
                        f"Use one of: {', '.join(CATEGORIES)}"
                    )
                sections.setdefault(category, [])
                continue
            if not line.strip():
                continue
            if category is None:
                sys.exit(f"{path.name}: text before any '### Category' heading")
            if line.startswith("-") or line.startswith("*"):
                sections[category].append(line.rstrip())
            else:
                # A continuation line of the bullet above — wrapped prose, or an
                # indented sub-bullet. Joining it to the previous entry keeps
                # multi-line entries intact instead of silently dropping them.
                if not sections[category]:
                    sys.exit(f"{path.name}: continuation line before any bullet")
                sections[category][-1] += "\n" + line.rstrip()
    return sections


def collate() -> str:
    sections = read_fragments()
    if not sections:
        return ""
    out: list[str] = []
    for category in CATEGORIES:
        bullets = sections.get(category)
        if not bullets:
            continue
        out.append(f"### {category}\n")
        out.extend(bullets)
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def bump_versions(version: str) -> None:
    """Set the version in the three files that carry one as source.

    Cargo.lock carries it too, but it is generated — `restamp_lockfile` hands
    that one to cargo.

    Every one is a targeted substitution, including the JSON. Parsing and
    re-serialising those looks tidier and is worse: `json.dumps` re-escapes
    non-ASCII, so the first run mangled an em-dash in package.json's
    description into `\\u2014` — a release that silently edits prose it was
    never asked to touch. A regex changes the version and nothing else.
    """
    edits = [
        # Cargo.toml: anchored to a line-initial `version = ` so it can only
        # match [workspace.package], never a dependency's version.
        (ROOT / "Cargo.toml", r'(?m)^version = "[^"]+"$', f'version = "{version}"'),
        (ROOT / "package.json", r'"version": "[^"]+"', f'"version": "{version}"'),
        (
            ROOT / "desktop" / "src-tauri" / "tauri.conf.json",
            r'"version": "[^"]+"',
            f'"version": "{version}"',
        ),
    ]
    for path, pattern, replacement in edits:
        text = path.read_text()
        new, n = re.subn(pattern, replacement, text, count=1)
        if n != 1:
            sys.exit(f"{path.name}: could not find a version to replace")
        path.write_text(new)


def restamp_lockfile() -> None:
    """Point Cargo.lock at the version `bump_versions` just wrote.

    Cargo.lock records a version for each of the three workspace members, so it
    is a fourth file carrying the number — but a generated one, which is why
    cargo restamps it rather than a regex like the others. `--workspace` limits
    the update to those three; `--offline` keeps a release from silently
    resolving new dependency versions, which is a separate change that has no
    business riding along inside a release commit.

    Left out, the lock stays a version behind until the next `cargo build`
    rewrites it — so it lands as an unrelated dirty file in whichever worktree
    builds first, and `wt-fold` refuses to fold while the canonical checkout is
    dirty. The release that causes it and the fold it blocks are far enough
    apart to look unconnected.

    A failure here is a warning rather than an exit: the changelog and the other
    three files are already written by this point, and dying would leave a
    half-cut release for a file the next build regenerates anyway.
    """
    try:
        done = subprocess.run(
            ["cargo", "update", "--workspace", "--offline"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
    except OSError as err:  # no cargo on PATH
        print(f"warning: could not restamp Cargo.lock ({err})", file=sys.stderr)
        return
    if done.returncode != 0:
        print(
            "warning: could not restamp Cargo.lock — commit it separately after "
            f"the next build:\n{done.stderr.strip()}",
            file=sys.stderr,
        )


CURRENT_VERSION = re.compile(r'(?m)^version = "(\d+)\.(\d+)\.(\d+)"$')


def current_version() -> tuple[int, int, int]:
    match = CURRENT_VERSION.search((ROOT / "Cargo.toml").read_text())
    if match is None:
        sys.exit("Cargo.toml: could not read the current workspace version")
    return int(match[1]), int(match[2]), int(match[3])


def resolve_version(spec: str) -> str:
    """Turn `patch` / `minor` / an explicit `X.Y.Z` into a version string.

    Deriving it beats naming it. Releases happen on every fold now, so the
    number is picked many times a day by whoever is folding — and the two
    mistakes available when typing it by hand (reusing the current version,
    or skipping one) both land in three files and a changelog heading before
    anything notices.
    """
    if re.fullmatch(r"\d+\.\d+\.\d+", spec):
        return spec
    major, minor, patch = current_version()
    if spec == "patch":
        return f"{major}.{minor}.{patch + 1}"
    if spec == "minor":
        return f"{major}.{minor + 1}.0"
    sys.exit("Version must be 'patch', 'minor', or an explicit X.Y.Z")


def check_not_stale() -> None:
    """Refuse to release from a branch that hasn't caught up with origin/main.

    Two agents releasing at once is the one way the fragment scheme can still
    produce a conflict: both read the same current version, both pick the same
    next one, and both write the same three files. Whoever folds second gets a
    real conflict — and worse, a *silently* wrong result if they resolve it
    carelessly, since two different releases would claim one number.

    Being level with origin/main doesn't make that impossible, but it closes
    the window from "however long this branch has existed" to "however long
    this fold takes", which is the difference between routine and rare.
    """
    try:
        # Plain `git fetch origin`, not `git fetch origin main`: the latter is
        # only opportunistic about updating refs/remotes/origin/main, and the
        # comparison below reads that ref.
        subprocess.run(["git", "fetch", "--quiet", "origin"], cwd=ROOT, check=True)
        merge_base = subprocess.run(
            ["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"],
            cwd=ROOT,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError):
        # No network, no remote, a detached checkout — none of which is a
        # reason to block a release. The check is a guard rail, not a gate.
        return
    if merge_base.returncode != 0:
        sys.exit(
            "origin/main has commits this branch doesn't.\n"
            "Merge it first (`git merge origin/main`), or another release may "
            "already have claimed the next version."
        )


def release(spec: str) -> None:
    check_not_stale()
    version = resolve_version(spec)
    body = collate()
    if not body:
        sys.exit("No fragments in changelog/unreleased — nothing to release.")
    today = datetime.date.today().isoformat()
    text = CHANGELOG.read_text()
    marker = "<!-- releases below -->"
    if marker not in text:
        sys.exit(f"CHANGELOG.md: missing the '{marker}' insertion point")
    section = f"## {version} — {today}\n\n{body}"
    CHANGELOG.write_text(text.replace(marker, f"{marker}\n\n{section}", 1))

    for path in sorted(FRAGMENTS.glob("*.md")):
        path.unlink()
    bump_versions(version)
    restamp_lockfile()
    print(f"Released {version}. Review the diff, then commit.")


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "collate":
        sys.stdout.write(collate() or "No fragments in changelog/unreleased.\n")
    elif len(sys.argv) == 3 and sys.argv[1] == "release":
        release(sys.argv[2])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
