# Rendered previews: reviewing prose and artifacts, not their source

> **Status: every format in this plan is implemented.** Markdown, HTML,
> `.ipynb`, `.csv`/`.tsv`, `.svg`, Mermaid (both `.mmd` files and fenced
> blocks) and Graphviz `.dot` all render, with selection → comment, comment
> display and suggest-from-source on each, and the preview replaces a file's
> diff **in place** rather than opening a modal. Stage 6 (whole-surface docs
> mode) is the only unbuilt piece. Where the build diverged from this plan —
> including one claim below that turned out to be wrong — is recorded at the
> end.

A growing share of what gets reviewed in krit is not code: design docs,
READMEs, plans, and self-contained HTML artifacts, all written by an agent. A
unified diff is the wrong lens for these. The reviewer wants to read the
*document* and object to a sentence, not scan `+`/`-` lines of Markdown source.

The gap this fills is a real one everywhere else: GitHub has had a rich-diff
toggle for Markdown and SVG for years and still will not accept an inline
comment on it ([community discussion
#186730](https://github.com/orgs/community/discussions/186730)); the same is
true of its notebook rich diff. The usual answer is a browser extension that
bolts comment affordances onto the rendered view and links them back to the
source pane ([md-review-extension](https://github.com/sabbour/md-review-extension),
[ReviewNB](https://blog.reviewnb.com/how-to-add-comments-to-notebook-diffs-github/)
for notebooks). krit owns both panes, so it can do the thing those extensions
approximate.

## The load-bearing fact: krit's schema is already the right target

krit persists a character-level anchor on every comment (schema v3 in
`src/types.ts`): `lineNumber`/`endLine` plus `startColumn`/`endColumn`/
`selectedText`, offsets into the *source* file. That is exactly what a
selection in a rendered document needs to produce, and it is already what the
selection path in the diff produces — `SelectionAnchor` in
`src/ui/utils/selectionMapping.ts`, handed to `handlePillComment`
(`CodeViewWrapper.tsx:931`) and on into `CommentForm`.

So a rendered preview is not a new comment kind. It is a second producer of
`SelectionAnchor`. Everything downstream is unchanged: drafts, the annotation
UI, the suggestion payload, Rust-side re-anchoring (`krit/src/reanchor.rs`
works on line content and never learns where the anchor came from), the wire
format, and the agent-facing rendering. No schema change, no server change for
Markdown at all.

The whole feature therefore reduces to one question per format: **can a
selection over rendered output be mapped back to a source (line, column)
range?**

## Markdown: the mapping is exact, and free

Verified against `unified@11.0.5` / `remark-parse@11` / `remark-rehype@11.1.2`
/ `react-markdown@10`:

- Every mdast node carries `position` with `line`, `column` and `offset`,
  **including inline nodes** — `strong`, `link`, and bare `text` runs all have
  precise start/end offsets.
- `remark-rehype` **preserves `position` on the hast tree**. Widely repeated
  advice says it strips it; that is wrong for current versions. What it does
  not do is emit a `data-sourcepos` attribute — that part is on you, and it is
  a ten-line rehype plugin:

  ```js
  visit(tree, 'element', (node) => {
    const p = node.position
    if (p?.start?.offset == null) return
    node.properties.dataSrc = `${p.start.offset}-${p.end.offset}`
  })
  ```

  Verified end-to-end through `react-markdown`: the attribute lands on real
  DOM elements (`<strong data-src="19-27">`). `react-markdown` also passes the
  hast node — position included — to custom components, so either route works.
- Only synthetic inter-block whitespace text nodes lack a position. No element
  that a human can select inside is missing one.

Mapping a DOM selection to a source range is then: walk up from each endpoint
to the nearest `[data-src]`, read the offsets, convert to line/column with a
line index over the source. This is *easier* than the existing diff path,
which has to pierce Pierre's shadow root and hit-test coordinates
(`selectionMapping.ts`); a preview is plain light DOM, so `getSelection()`
works directly and the whole shadow-root apparatus is unnecessary.

### The one wrinkle: rendered text is shorter than its source

A `text` node's rendered value is not its source slice when escapes or
entities are involved. Measured:

```
"A *escaped* star and & entity and "   ← 34 rendered chars
 A \*escaped\* star and &amp; entity and    ← source offsets 0..40
```

So an offset *inside* a text node cannot be mapped linearly. It is exact only
at node boundaries. Two-tier rule:

1. If `source.slice(start, end).length === node.value.length` for the text node
   an endpoint falls in — the overwhelmingly common case — add the intra-node
   offset directly. Exact.
2. Otherwise snap that endpoint **outward** to the text node's own boundary.
   The persisted source range is then a superset of what was highlighted,
   which is safe, and `selectedText` still records precisely what the human
   selected.

That second tier is the answer to "tying the section back to the raw code is
probably too hard": it never has to be perfect, because `selectedText` carries
the human's actual intent and the source range only has to be *containing*.

### Showing what changed

A preview that just renders the new file loses the diff. It does not have to:
krit already has the patch, so it knows which source line ranges are added or
modified, and every rendered block now carries its source range. Intersect the
two and stamp `data-changed` on the blocks that overlap, then draw a gutter
stripe. Cheap, and it gives the reviewer the "what did the agent actually
change in this doc" read that the rich diff on GitHub is for.

Word-level prose diffing merged into a single rendered tree is the fancier
version and is explicitly out of scope — it is a large amount of work for a
reviewer who can already toggle back to the source diff.

### Cost

Bundled with esbuild, minified, React external:

| Stack | raw | gzipped |
|---|---|---|
| `react-markdown` + `remark-gfm` | 156 KB | 46 KB |
| … + `rehype-raw` | 349 KB | 98 KB |

`rehype-raw` more than doubles it because it embeds a full HTML parser. It is
also not optional in practice: agent-written docs routinely use `<details>`,
`<img>`, `<kbd>`, `<sub>`. Pair it with `rehype-sanitize` on a permissive
schema (allow those, strip `script`/`style`/event handlers) and lazy-load the
whole preview module with a dynamic import so the diff path pays nothing.

Alternatives considered. `markdown-it` gives `token.map`, but **block-level
only** — no inline positions, which kills character anchoring. `streamdown` is
a drop-in `react-markdown` replacement with Shiki, KaTeX and Mermaid built in;
attractive later, but it is tuned for streaming LLM output and krit already
has Shiki via Pierre, so starting from `react-markdown` keeps the dependency
surface honest.

## HTML artifacts: sandbox first, anchor second

Rendering agent-written HTML has a security shape that Markdown does not.
krit's page is same-origin with an API that **writes files to disk**
(`PUT /api/file-content`). Inlining artifact HTML — sanitized or not — puts
author-controlled markup in that origin, and sanitizing also destroys the
interactivity that makes an artifact worth previewing.

Use an iframe with `sandbox="allow-scripts"` and **not** `allow-same-origin`
(the two together defeat the sandbox). That puts the artifact in an opaque
origin, so its scripts run, its `fetch` to krit's API is cross-origin with no
CORS headers and fails, and its DOM is unreachable from the parent. Inject a
`<meta http-equiv="Content-Security-Policy">` with `connect-src 'none'` as the
first policy in the document — per spec the first policy wins, so it overrides
whatever the artifact declares.

That isolation costs us the selection: the parent cannot read
`contentWindow.getSelection()` across an opaque origin. Inject a small bridge
script that listens for `mouseup`, serializes the selection, and
`postMessage`s it out; the parent verifies `event.source === iframe.contentWindow`.

Anchoring back to source is genuinely harder than Markdown and should be a
fallback ladder rather than a guarantee:

1. **Source locations from `parse5`.** Verified: with
   `{sourceCodeLocationInfo: true}` every element *and text node* gets
   `startLine`/`startCol`/`startOffset`/`endOffset`. Have the bridge report a
   child-index path from `body`, walk the same path in the parsed source tree,
   read the location. Exact — as long as the artifact's live DOM matches its
   parsed source.
2. **Quote match.** If the path misses (the artifact's JS mutated the DOM,
   which is common), search the source for `selectedText`. Unique match wins.
3. **Whole-file comment.** Anchor at line 1 with `selectedText` set, and say so
   in the UI.

Tier 3 is an acceptable floor precisely because the agent gets the selected
text and can find the right place itself. Do not let the pursuit of tier 1
hold up the feature.

## What this breaks: Suggest from a preview

Non-obvious and worth deciding before writing code. `CommentForm`'s suggest
mode seeds a CodeMirror editor with `selectedText` and diffs the result to
build `suggestion.newLines` (`CodeViewWrapper.tsx:975-982` explains why it is
the selection and not the full lines). From a preview, `selectedText` is
*rendered* text — the human would be editing `bold` where the source says
`**bold**`, and the resulting suggestion would not apply.

Three options, in order of preference:

1. **Seed the suggest editor with the source slice.** We computed it to build
   the anchor, so it costs nothing. The reviewer selects rendered prose and
   then edits the Markdown behind it — honest about what is being changed, and
   the suggestion stays a literal patch.
2. Disable Suggest in preview; Comment only. Simple, and a real loss.
3. Emit the suggestion as prose intent rather than a patch. Weakens a contract
   the agent currently relies on. Not recommended.

Option 1 also degrades correctly under the outward-snap rule: the reviewer
sees slightly more source than they highlighted, which is the right failure.

## Where the preview renders

**This section's original claim was wrong and is corrected below.** It read:
"CodeView owns the scroller and only knows `file`/`diff` items, so a rendered
document cannot be inlined without upstream support." It can, using two
documented mechanisms and no upstream changes — see "Inlining, as built". The
two placements originally proposed were:

- **Per-file modal**, exactly the pattern `FileEditorModal` already
  establishes for whole-file editing, reached from a new button beside `Edit`
  and `⤢` in `renderHeaderPrefix` (`CodeViewWrapper.tsx:1073`). Lowest risk,
  smallest diff, reuses an established shape.
- **Docs mode**, a toolbar toggle that swaps the whole review surface for a
  scrollable stack of rendered previews. This is closer to what a reviewer of
  a docs-heavy branch actually wants — read the documents, comment as you go —
  but it is a second full review surface to build and maintain.

### Inlining, as built

The modal shipped first and was then replaced. A previewed file keeps its
header and its place in the shared scroll, and its diff body is swapped for
the rendered document:

- The document is a **file-level annotation** — `lineNumber: 0`, which Pierre
  documents as "above the first hunk". `renderAnnotation` already renders
  arbitrary React, and that output is **light DOM** projected by `slot`, so
  `global.css` applies with no injected stylesheet and no shadow piercing.
- The rows are removed by handing CodeView a **hunk-less copy of the
  fileDiff**, not by collapsing. `collapsed: true` suppresses annotations too,
  which would take the document with the rows.

Three smaller obstacles, each recorded in `CLAUDE.md` because each fails
silently: `AnnotationEventGuard` swallows the `mouseup` a selection depends
on; the virtualizer's `transform` captures `position: fixed`, so the selection
pill must be portaled to `<body>`; and the pane inherits Pierre's monospace
font unless it sets its own.

Docs mode (stage 6) is still unbuilt and is now a smaller step: a toggle that
puts every previewable file into preview at once.

## Displaying comments over rendered content

The diff gets annotation rows injected between lines. A document cannot: an
anchor is mid-paragraph, not between blocks. The established answer is a
margin rail with `<mark>` highlights on the anchored ranges and connectors to
the cards — Hypothesis and Google Docs both, and it is what the W3C Web
Annotation model was shaped around.

Reverse mapping (source range → DOM range) uses the same `[data-src]` index
walked downward, with the same two-tier exactness rule. For robustness on a
document that has since changed, the annotation literature converges on
storing multiple selectors and trying them in order —
[Hypothesis](https://web.hypothes.is/blog/fuzzy-anchoring/) keeps a text
position, a text quote and a range selector, and uses the quote as a *check*
on whichever strategy matched. krit already stores position and quote
(`startColumn`/`endColumn` and `selectedText`), so it has the two that matter
and needs no new persisted state. One caution from that same project: naive
fuzzy matching via `diff-match-patch` degrades badly on short quotes in long
documents ([client#3919](https://github.com/hypothesis/client/issues/3919)) —
prefer exact match plus a bounded window before reaching for fuzz.

## Other formats worth fitting in

Ranked by value over effort. All of them reduce to the same question — does
the format give us a source position?

**`.ipynb` — built.** A notebook diff in raw JSON is
unreadable, which is why every tool in the space renders cells and why
[ReviewNB](https://blog.reviewnb.com/commenting-and-discussion-on-jupyter-notebook/)
exists as a paid product wrapping exactly this gap. Anchoring is
straightforward with a position-tracking JSON parser: cell index → source line
range, and markdown cells reuse the entire Markdown path above. Cell outputs
render as-is; images already have a home in `BinaryFileDiff`.

**`.csv` / `.tsv` — built.** Table render, and anchoring is
*exactly* line/column with no escape wrinkle at all (modulo quoted fields).
Almost free once the preview scaffolding exists.

**`.svg` — built.** Rendered inline through an allowlist; anchored off each
element's own source offsets. GitHub's rich diff covers SVG for the same
reason.

**Mermaid — built.** Both `.mmd` files and fenced
` ```mermaid ` blocks inside Markdown, which is where agents actually put
them. Mermaid emits node ids derived from node names, so per-node anchoring is
plausible; whole-diagram anchoring is fine for v1. It is a large dependency —
lazy-load it separately from the Markdown module.

**Graphviz `.dot` — built**, same shape as Mermaid via a wasm build.

Not worth it: **AsciiDoc** and **reStructuredText** (weak or absent JS
tooling, and nothing agent-written targets them); **PDF** (not a thing that
gets diffed in a repo); **JSON/YAML** (the source diff already reads fine —
rendering would be strictly worse).

## Testing

The pure parts are the bulk of the work and are all directly testable in
Vitest: source-offset stamping, the two-tier offset rule, source-range →
line/column, changed-block intersection, and the reverse map. Keep them as
exported pure functions per the existing convention.

The geometry is not testable under happy-dom, for the reasons already recorded
in `CLAUDE.md`. Note one thing in our favor though: previews render in light
DOM, so the selection path here needs the plain Selection API and inherits
none of the shadow-root retargeting problems that `selectionMapping.ts` was
built to work around. Playwright WebKit still owns the end-to-end proof, and
the iframe bridge in particular can only be verified in a real engine.

## Staging

1. Markdown preview, read-only, per-file modal, with `data-src` stamping and
   changed-block stripes. Proves the renderer and the diff overlay.
2. Selection → `SelectionAnchor` → existing comment flow. Proves the thesis;
   this is the point at which the feature is actually useful.
3. Comment display: margin rail, highlights, reverse mapping.
4. Suggest-from-preview seeded with the source slice.
5. HTML artifacts: sandboxed iframe, bridge, the anchoring ladder.
6. Docs mode as a whole-surface toggle.
7. `.ipynb` and `.csv`, which by then are renderers plugged into finished
   machinery.

## What changed in the building

Stages 1–5 shipped. Four things came out differently from the plan.

**`parse5` was not needed, and HTML anchoring is better than tier 2.** The
plan expected to ship a parser or fall back to quote matching. Instead
`htmlTextMap.ts` scans the source once and emits the text a browser would
render alongside the source offset of each character, and the bridge reports a
selection as an offset into the same string. That is exact for a static
artifact, with the quote search kept as the documented fallback for one whose
scripts rewrote the DOM. No new dependency, and the ladder still degrades the
way the plan describes.

**That scan and the bridge's traversal are one contract, and it is fragile in
a silent way.** Both halves must agree on what counts as visible text, or every
offset shifts and the anchor is quietly wrong. Two traps hit during
implementation — `<!DOCTYPE html>` counted as text, and the newline between
`</head>` and `<body>` that the parser drops — each shifted the whole document.
`visibleTextOffsetOf` is therefore serialised into the bridge with `toString()`
so a single copy of the traversal exists, and the tests assert agreement on
every text run rather than on a sampled one.

**The exactness rule landed as "locate the run", not "compare lengths".** The
plan's rule was: map linearly when a text node's rendered length equals its
source slice length, else snap outward. That is too coarse in practice —
`<p>Para with **bold** tail.</p>` fails the length check as a whole, so a
selection anywhere in the paragraph would have widened to the paragraph. What
ships instead searches for the text node's exact value inside its element's
source slice, using the rendered prefix length as a search floor (sound,
because markup only ever adds characters, and it also disambiguates a repeated
run). Selections inside emphasis, links and code spans come out exact;
escapes and entities still snap outward as designed.

**The markdown stack is lazy-loaded.** It measured at +324 kB raw / +99 kB
gzipped, about a quarter of the bundle, on a path most reviews never take.
`PreviewModal` is a `lazy()` import, which puts it in its own chunk and leaves
the main bundle within ~1 kB of where it was.

Not covered by tests: a human drag inside the HTML preview's iframe. Nothing
can deliver input into it (see `CLAUDE.md`), so `BRIDGE_SCRIPT` is executed
against a document in `htmlSandbox.test.ts` instead — which reaches everything
except the browser's own selection geometry.

**Stage 7 needed no new machinery, only a second kind of offset.** A renderer's
whole obligation is `data-src`, so `.csv` was a table whose cells carry their
own file offsets and nothing else changed. `.ipynb` is the one format where a
rendered offset is not an offset into the file: cell text lives inside JSON
string literals, and `\n` is two source characters for one decoded one. So
`jsonPositions.ts` keeps a per-character map alongside every string it parses,
and the Markdown renderer gained a `mapOffset` hook to push its stamps through
it. The locate-by-value rule then works unchanged, because a run of cell text
does occur verbatim inside its own literal — a paragraph split across two
`source` entries is the case that snaps outward, which is why code cells are
stamped a line at a time rather than as a whole.

Cell **outputs are deliberately unstamped**. There is no source position behind
a rendered figure, and an unstamped subtree yields no anchor rather than a
plausible wrong one. `text/html` outputs are dropped for the same reason the
HTML preview is sandboxed: they are arbitrary kernel-authored markup, and the
notebook pane renders in the page.

**A diagram anchors by quote, and that took no new code.** Mermaid and Graphviz
render from text to a picture, so there are no per-element source offsets to
stamp — the offsets in the generated SVG describe markup nobody is reviewing.
The picture is therefore wrapped in *one* element carrying the diagram source's
span, and the locate-by-value rule already in `previewAnchor.ts` searches that
slice for the selected label's text. Selecting a node in a rendered flowchart
lands on the line that declared it, exactly, and a label Mermaid rewrapped
snaps outward to the whole diagram. That is the ladder's quote tier arriving
for free, which is the strongest evidence so far that `data-src` was the right
contract to build everything on.

**The floor heuristic had a hole, and diagrams are what found it.** The
locate-by-value search starts at the count of rendered characters preceding the
text node, justified by "markup only ever adds characters, so a source position
is never earlier than its rendered position". Mermaid emits ~5 kB of generated
CSS in a `<style>` inside the stamped element — more text than most reviewed
files contain — which pushed the floor past the end of the source and made
*every* diagram selection snap to the whole file. `renderedOffsetOf` now skips
elements whose text is never painted. The same hole was reachable from a
`<style>` block in a Markdown document's raw HTML; nothing had hit it.

**Inline SVG is markup in this page's origin, so it is rebuilt, not injected.**
`parse5` was not needed here either: `xmlPositions.ts` parses with offsets, and
`svgPreview.ts` reconstructs the tree with `createElementNS` through an
allowlist — no `innerHTML` on any preview path. Scripts, `foreignObject`,
external references and `url()` to anywhere but a document fragment are
dropped, and what was dropped is *named on screen*, because a picture missing
its `<image>` looks exactly like a picture that never had one. The HTML preview
still gets the opaque-origin iframe instead: an artifact is a program and has
to keep its scripts to be worth previewing, while an SVG that needs a script is
not a diagram anyone is reviewing as one.

Both engines are behind `import()`. Graphviz's wasm is 1.4 MB and Mermaid is
about a quarter of the bundle again; the main chunk grew by under a kilobyte.
