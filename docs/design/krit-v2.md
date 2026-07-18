# krit: the v2 backend

diffx v2 is **krit**: same review workflow, new identity, greenfield backend in
Rust. The name change drops the fork pretense — little upstream code survives —
and gives v1 and v2 disjoint namespaces so they can run side by side.

## Decisions

- **Language: Rust** (axum + tokio). Chosen over Go for three properties core
  to this workload: FSEvents-native recursive watching via `notify` (macOS is
  the primary platform; Go's fsnotify is kqueue-only there — per-directory
  registration and fd-per-entry pressure), a serde-tagged-enum event protocol
  (the wire format is a discriminated union; making malformed frames
  unrepresentable beats convention-checked JSON), and deterministic single-digit-MB
  memory for a long-idle daemon. Cost accepted: slower build-out in a secondary
  language, mitigated by the walking-skeleton order below and the v1 fallback.
- **The v1 HTTP/ws API is the frozen contract.** Routes, JSON shapes, event
  frames, and the state-file schema stay wire-compatible (state file gains
  `"v": 2`). The React UI and the Claude skill target the contract, not the
  implementation — so the frontend and backend tracks proceed independently,
  and either backend can serve either UI build. Additive changes allowed;
  breaking changes require moving UI + skill + server together.
- **Single static binary, UI embedded** (`rust-embed`). Eliminates the
  stale-dist class of failure entirely: no `dist/`, no node_modules, no runtime
  on PATH.
- **Keep shelling out to `git diff`** and stream-parsing stdout. Exact git
  semantics (rename detection, diff algorithms, textconv) for free; libgit2 and
  gitoxide both have weaker diff surfaces.

## Architecture

- **Event core is the center**: one `tokio::sync::broadcast` bus. SSE
  subscribers, ws subscribers, the idle-timer, and persistence are all just
  consumers. Presence and principal-based lifecycle (browser = principal; agent
  and CLI subscribers never hold the server alive) are bus-level logic,
  testable without HTTP.
- **Protocol as a type**: `#[serde(tag = "type")] enum Event` shared by every
  producer and consumer in the crate.
- **Store as a single-writer actor**: one task owns the comment store; handlers
  and the watcher talk to it over a message channel. Re-anchoring
  (exact-match near old position → fuzzy → `outdated`) is a pure function with
  property tests.
- **Watcher**: `notify` (FSEvents) + `notify-debouncer-full`; ignore rules for
  `.git`, `node_modules`, `.claude` carried over from v1.
- **Transports first-class in axum**: SSE as a typed response, ws as a
  `WebSocketUpgrade` route — no upgrade-handler sidecar.
- **Every exit path logs its reason** to a log file next to the state file.
  (v1's silent-SIGTERM forensics motivated this.)
- Shutdown: broadcast `review-ended`, close subscriber streams explicitly,
  then a bounded-grace exit. The v1 idle-shutdown deadlock
  (close waiting on live streams) must be unrepresentable in the design, not
  patched around.

## Build order: walking skeleton

Vertical slices, each leaving a runnable demo — never an 80%-done valley:

1. **Skeleton**: serve embedded UI + `/api/diff` (shell-out, parse, serve) +
   `/api/state`. The v1 UI renders a diff from the Rust server.
2. **Event core**: broadcast bus, SSE + ws endpoints, presence frames,
   principal lifecycle + idle shutdown.
3. **Comments**: store actor, CRUD routes, replies/resolve, CLI verbs,
   persistence, `submitted`/`review-ended` semantics.
4. **Watcher**: FSEvents + debounce + per-file refresh events, re-anchoring.
5. **Polish**: drafts, char-anchored comments, suggest-edit apply — contract
   parity checklist against v1.

## Coexistence with v1

- v1 (`diffx`, Node) stays installed and untouched on `main`; krit lives on
  the `v2` branch.
- Disjoint namespaces: binary `krit`, state file
  `$CLAUDE_TMPDIR/krit-state.json`, own port. A v2 bug mid-review means:
  kill krit, launch `diffx`, same workflow.
- The skill grows a krit variant (or a binary probe) once slice 3 lands;
  until then the skill remains v1-only.

## Frontend track (independent, same branch)

- Bump `@pierre/diffs` to 1.3.0-beta.x; demo the inline editor against the
  suggest-edit flow — Pierre is converging on the same in-line-editing
  direction, so evaluate replacing the CodeMirror suggest machinery with it,
  and file upstream issues while the beta can still absorb them.
- Known v1 gaps to revisit under 1.3.0: file add/remove full-remount (no
  `removeItem`), `FileDiffContentsLoader` for perf.

## Roadmap: ideas adopted from crit.md

[crit](https://github.com/tomasz-tomczyk/crit) is a same-niche tool (Go
single-binary, round-based batch protocol, framework-free vanilla-JS diff
renderer — the opposite bets from ours on both interaction model and frontend).
Ideas worth adopting, roughly in order:

1. **Drift tri-state on comment anchors.** Alongside `selectedText`, carry
   `quote`/`anchor`/`drifted` semantics: agent instructions prefer the quoted
   text over line numbers, and `drifted` explicitly means "relocation failed,
   line numbers approximate" rather than v1's binary `outdated`. Design into
   the protocol enum from the start. Their relocation appears to build on
   diff-match-patch — consider a fuzzy-match primitive of that family for
   re-anchoring instead of bespoke heuristics.
2. **Plan-mode review.** Line-anchored margin comments on a markdown document
   (a plan, a design doc) — same store, same events, renderer swaps to
   markdown. Argument auto-detection picks the mode: `krit plan.md`,
   `krit -- <git-args>`, bare = branch diff.
3. **Round-to-round diff.** "What changed since your last look" as a
   first-class view composed with live refresh: snapshot on each
   submit/refresh boundary, offer current-vs-last-round.
4. **Lifecycle hooks, with crit's security posture.** Opt-in
   `on_finish_*` shell hooks with JSON stdin payload; project-level hooks
   gated behind an explicit trust step; anything that executes configured
   commands is global-config-only so a cloned repo can never run code.
5. **Resolution etiquette toggle.** Keep v1's default (agent resolves what it
   believes it addressed) but add a mode where resolving is reserved to the
   reviewer and the agent only replies.
6. **`krit status`.** State-file info plus daemon liveness in one command.
7. **Story mode.** Optional generated narrative layer over a large diff —
   prologue + thematic chapters grouping hunks; an explainer, never a judge.
   Our live agent connection could generate it in-session.

Explicitly not adopted: their round-based blocking protocol (we keep the live
event stream), and the share/self-host server (out of scope).

## Name

`krit` — review-flavored (critique), four letters, personal-k prefix.
Checked 2026-07-17: nothing on PATH, npm, homebrew-core, or crates.io. Not to be
confused with crit.md (a different local agent-review tool); spelling is
distinct everywhere it is typed or searched.
