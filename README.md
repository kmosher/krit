# diffx

A local code review tool for git diffs. Review your changes in a GitHub PR-like web UI before committing, then copy all comments for your coding agent to fix.

![screenshot](https://raw.githubusercontent.com/wong2/diffx-cli/main/screenshot.png)

## Install

```bash
npm install -g diffx-cli
```

## Usage

Run in any git repository:

```bash
diffx
```

This starts a local server and opens your browser with a diff review UI.

### Options

```
diffx [options] [-- <git-diff-args>]

Options:
  -p, --port <port>   Server port (default: 3433)
  --no-open           Don't auto-open browser

Examples:
  diffx                          # Review working tree changes
  diffx -p 8080                  # Use custom port
  diffx -- HEAD~3                # Diff against 3 commits ago
  diffx -- main..HEAD            # Diff between branches
  diffx -- --cached -- src/      # Staged changes in src/
```

## Features

- **Split / Unified view** — Toggle between side-by-side and inline diff
- **Syntax highlighting** — Powered by Shiki with GitHub themes
- **File tree** — Hierarchical file browser with search filter
- **Inline comments** — Click the `+` button on any line to add a review comment
- **Copy comments** — One-click copy all comments as structured XML for AI coding agents
- **Viewed tracking** — Mark files as reviewed to track progress
- **Staged / Untracked toggles** — Choose which changes to include
- **Custom diff commands** — Pass any `git diff` arguments after `--`
- **Persistent settings** — Your preferences are saved across sessions

## Comment Output Format

When you click "Copy comments", the output is structured XML optimized for AI agents:

```xml
<code-review-comments>
<file path="src/utils/parser.ts">
<comment line="42">
<code>+ const parsedToken = tokenize(input)</code>
Rename `x` to `parsedToken` for clarity.
</comment>
<comment line="15">
<code>- if (input != null) {</code>
This null check removal may cause a bug when `input` is undefined.
</comment>
</file>
</code-review-comments>
```

Each comment includes the commented code line with a `+`/`-` prefix indicating whether it's an added or removed line.

## License

MIT
