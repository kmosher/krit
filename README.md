# diffx

A local code review tool designed for the coding-agent workflow. Review AI-generated changes in a GitHub PR-like web UI, leave inline comments, then hand them back to your coding agent to fix — or have the agent watch your comments and respond as you write them.

![screenshot](https://raw.githubusercontent.com/wong2/diffx/main/screenshot.png)

## Install

```bash
npm install -g diffx-cli
```

## Usage

Run in any git repository:

```bash
diffx
```

This starts a local server on a random available port and opens your browser with a diff review UI. The server stays up waiting for you to leave inline comments; when you're done, click **Done reviewing** in the toolbar (or kill the server with Ctrl+C).

### Options

```
diffx [options] [-- <git-diff-args>]

Options:
  -p, --port <port>   Server port (default: random available)
  --host <host>       Bind address (default: 127.0.0.1; pass 0.0.0.0 for LAN)
  --no-open           Don't auto-open the browser
  -v, --version       Show version
  -h, --help          Show help

Examples:
  diffx                          # Review working tree changes
  diffx -- --staged              # Only staged changes
  diffx -- HEAD~3                # Diff against 3 commits ago
  diffx -- main..HEAD            # Diff between branches
  diffx --host 0.0.0.0           # Allow other machines on the LAN to review
```

### Session subcommands

While a `diffx` server is running, the same binary works as a client for it (auto-discovered via a state file at `$CLAUDE_TMPDIR/diffx-state.json` or `~/.diffx/state-<sha1(cwd)>.json`):

```
diffx state                       # Print state JSON (port, pid, url, etc.)
diffx comments [open|resolved|replied|all]
                                  # List comments, optionally filtered
diffx reply <id> <text...>        # Reply to a comment (tagged author: 'agent')
diffx resolve <id>                # Mark a comment resolved
diffx reopen <id>                 # Reopen a resolved comment
diffx watch                       # Stream comment/reply/submitted events as JSON
                                  # lines on stdout (exits 0 when the user clicks
                                  # Done reviewing, 2 on disconnect, 130 on Ctrl+C)
diffx wait-for-submit             # Block until the user clicks Done reviewing
```

`diffx watch` is the integration point for an agent that wants to respond to comments as the user writes them — each new comment or user reply emits one JSON line; the agent's own `diffx reply` calls don't echo back, so there's no self-feedback loop.

## Features

- **Split / Unified view** — Toggle between side-by-side and inline diff
- **Syntax highlighting** — Powered by Shiki with GitHub themes; respects `.editorconfig` for per-file tab size
- **File tree** — Hierarchical browser with search filter, collapsible sidebar, and file change-type icons
- **Inline comments** — Click the `+` button on any line, or **drag the gutter** across multiple lines to comment on a range
- **Conversation threads** — Reply to any comment from the browser. Agents reply via the `diffx reply` subcommand or the API; agent replies render with a bot avatar in violet, user replies in blue. Replying to a resolved comment auto-reopens it.
- **Expandable context** — Once both file versions have loaded, you can expand unedited lines above, below, and between hunks. Contents are fetched lazily as each file scrolls into view; files over 5 MB require an explicit "Load anyway" opt-in.
- **Comment status tracker** — Sidebar widget showing open / replied / resolved counts with click-to-navigate links
- **Done reviewing** — Submit pulse fires when you're finished; a connected `diffx watch` watcher exits cleanly
- **Copy comments** — One-click copy all comments as structured XML for an offline agent
- **Image preview** — Side-by-side comparison for added, modified, and deleted images
- **Viewed tracking** — Mark files as reviewed to track progress
- **Staged / Untracked toggles** — Choose which working-tree changes to include
- **Custom diff commands** — Pass any `git diff` arguments after `--`; expansion still works for `HEAD~N`, `X..Y`, `X...Y`, two-ref, and `--staged` invocations
- **Persistent settings** — Diff style, default tab size, browser choice, etc. saved across sessions

## Comment Output Format

When you click "Copy comments", the output is structured XML optimized for an AI agent:

```xml
<code-review-comments version="2">
<file path="src/utils/parser.ts">
<comment line="42">
<code>+ const parsedToken = tokenize(input)</code>
Rename `x` to `parsedToken` for clarity.
</comment>
<comment line="15" endLine="18">
<code>
- if (input != null) {
-   foo(input)
-   bar(input)
- }
</code>
This block is dead code after the refactor on line 9.
</comment>
</file>
</code-review-comments>
```

Each comment includes the commented code with a `+`/`-` prefix indicating addition or deletion. Range comments emit one diff line per row inside `<code>`. The `version="2"` root attribute lets a consumer detect the current shape; the `<code>` payload is XML-escaped, so generics, JSX, and `&` survive intact.

## Agent skills

Install the diffx skill to use diffx directly from your AI coding agent:

```bash
npx skills add wong2/diffx
```

The skill is a single streaming entrypoint: **`/diffx`**. The agent launches `diffx` (which opens the browser tab and waits for your comments), attaches a `diffx watch` monitor, and processes each comment / user reply as it arrives. The session ends when you click **Done reviewing** in the toolbar.

If you'd rather work batch-style without an attached agent, just click **Copy** in the toolbar and paste the XML into a chat — every consumer that parses the format above will still work.

### Inline suggestions

Every comment form has a **Suggest edit** toggle. Flip it on and the form pre-fills a monospace textarea with the lines you selected; edit them in place and submit. The comment then carries a `suggestion: { newLines }` payload alongside the body, and `Copy comments` emits it as a GitHub-style fenced block the agent can recognize:

````
<suggestion>
```suggestion
the rewritten lines
```
</suggestion>
````

### In-browser file editor

Each diff header has an **Edit** button. Click it to open a fullscreen editor seeded with the file's current working-tree contents; save (`⌘S` or the button) writes back to disk and the diff view refreshes immediately via SSE. Useful for quick rewrites you don't want to formalize as a suggestion — the agent picks them up on the next poll. The editor is a plain textarea today; the seam is intentionally small so a heavier editor (Monaco, CodeMirror) can drop in later.

## Developing locally

To run a working copy of diffx from a checkout (instead of the published `diffx-cli` package), point the global `diffx` binary at your source tree once and rebuild after each change:

```bash
git clone https://github.com/wong2/diffx.git   # or your fork
cd diffx
pnpm install
pnpm build                                     # produces dist/cli.mjs + dist/client/
pnpm link --global                             # exposes `diffx` on PATH from this checkout
```

`pnpm link --global` symlinks `<npm-global>/lib/node_modules/diffx-cli` to your checkout, so `which diffx` resolves to `dist/cli.mjs` in the working copy. Re-run `pnpm build` (or `pnpm dev:client` for live-reload during UI work) after editing.

If you also want the `/diffx` skill to track your local source, link the SKILL.md into Claude Code's skills directory:

```bash
mkdir -p ~/.claude/skills/diffx
ln skills/diffx/SKILL.md ~/.claude/skills/diffx/SKILL.md     # hardlink: edits visible at both paths
# or, more robust across git checkouts:
ln -s "$PWD/skills/diffx/SKILL.md" ~/.claude/skills/diffx/SKILL.md
```

The hardlink is what `npx skills add` lays down on first install — fastest path, but a git operation that rewrites the file via rename will break the link silently. The symlink survives every checkout (at the cost of a slightly less "vanilla" install).

## License

MIT
