#!/usr/bin/env python3
"""Collate changelog fragments, and cut a release.

See changelog/README.md for why fragments exist. This script is the only thing
that writes CHANGELOG.md, and the only thing that writes a version number: the
three files carrying one have to agree, and they are three separate merge
conflicts waiting to happen if each release edits them by hand.

    scripts/changelog.py collate            # print the merged section
    scripts/changelog.py release 0.3.0      # write CHANGELOG.md, drop fragments, bump versions
"""

from __future__ import annotations

import datetime
import pathlib
import re
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
    """Set the version in all three files that carry one.

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


def release(version: str) -> None:
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
    print(f"Released {version}. Review the diff, then commit.")


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "collate":
        sys.stdout.write(collate() or "No fragments in changelog/unreleased.\n")
    elif len(sys.argv) == 3 and sys.argv[1] == "release":
        if not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[2]):
            sys.exit("Version must look like 0.3.0")
        release(sys.argv[2])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
