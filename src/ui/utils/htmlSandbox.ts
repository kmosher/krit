// Builds the document krit drops into the preview iframe for an HTML file.
//
// The isolation that matters comes from the iframe's `sandbox="allow-scripts"`
// with **no** `allow-same-origin` (the two together cancel each other out).
// That puts the artifact in an opaque origin, so its scripts run — which is
// most of the point of previewing an artifact rather than reading its source —
// but its `fetch` at krit's own API is cross-origin against a server that
// sends no CORS headers, and its DOM is unreachable from this page.
//
// krit's origin can write files to disk (`PUT /api/file-content`), so inlining
// artifact markup into this page was never an option, sanitized or not.

/**
 * How many rendered characters inside `root` precede a DOM position.
 *
 * This is the iframe's half of the contract with `buildHtmlTextMap`: it must
 * traverse and skip exactly what the parent's source scan emits and skips, or
 * the offset it reports indexes a different string than the parent built.
 *
 * Deliberately self-contained — no imports, no closure over module scope —
 * because it is serialised with `toString()` into the injected bridge below.
 * That is what keeps the two halves from drifting: there is only one copy.
 * `htmlSandbox.test.ts` pins the agreement.
 */
export function visibleTextOffsetOf(root: Node, node: Node, offset: number): number {
  const SKIP: Record<string, number> = {
    SCRIPT: 1,
    STYLE: 1,
    TEMPLATE: 1,
    HEAD: 1,
    TITLE: 1,
    NOSCRIPT: 1,
  }
  let count = 0
  let done = false
  const walk = (n: Node) => {
    if (done) return
    if (n === node) {
      count += n.nodeType === 3 ? offset : 0
      done = true
      return
    }
    if (n.nodeType === 3) {
      count += (n.nodeValue || '').length
      return
    }
    if (n.nodeType !== 1 || SKIP[(n as Element).tagName]) return
    for (let c = n.firstChild; c; c = c.nextSibling) {
      walk(c)
      if (done) return
    }
  }
  walk(root)
  return done ? count : -1
}

/**
 * Injected into the previewed document. Reports selections out to the parent,
 * which cannot read them itself across the opaque origin.
 *
 * The artifact's own scripts share this window and can post the same messages.
 * That is accepted: the worst a forged message achieves is a comment quoting
 * text the reader did not select, which is visible to the reader and carries
 * no privilege. Nothing here hands the parent anything it acts on unchecked —
 * `locateSelection` verifies every offset against the source.
 */
export const BRIDGE_SCRIPT = `(function () {
  var visibleTextOffsetOf = ${visibleTextOffsetOf.toString()}
  function textOffsetOf(node, offset) {
    return visibleTextOffsetOf(document.body, node, offset)
  }
  function send(msg) {
    msg.source = 'krit-preview'
    parent.postMessage(msg, '*')
  }
  function report() {
    var sel = document.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { send({ type: 'selection', text: '' }); return }
    var range = sel.getRangeAt(0)
    var text = sel.toString()
    if (!text.trim()) { send({ type: 'selection', text: '' }); return }
    var r = range.getBoundingClientRect()
    send({
      type: 'selection',
      text: text,
      textOffset: textOffsetOf(range.startContainer, range.startOffset),
      rect: { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height }
    })
  }
  function reportHeight() {
    send({ type: 'height', height: document.documentElement.scrollHeight })
  }
  document.addEventListener('mouseup', function () { setTimeout(report, 0) })
  document.addEventListener('keyup', function (e) {
    if (e.shiftKey || e.key === 'Escape' || e.ctrlKey || e.metaKey) setTimeout(report, 0)
  })
  window.addEventListener('load', reportHeight)
  if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.documentElement)
  setTimeout(reportHeight, 50)
  setTimeout(reportHeight, 500)
})()`

// First policy wins per the CSP spec, so this overrides anything the artifact
// declares for itself. Inline script and style stay allowed because virtually
// every generated artifact is one file with both inlined; what is shut off is
// the network — no fetch, no XHR, no WebSocket, no remote font or image.
const CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'unsafe-inline'; " +
  'img-src data: blob:; ' +
  'font-src data:; ' +
  'media-src data: blob:; ' +
  "connect-src 'none'; " +
  "form-action 'none'; " +
  "frame-src 'none'"

const HEAD_INJECT =
  `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
  `<meta name="referrer" content="no-referrer">`

/**
 * The artifact source with krit's policy and bridge woven in.
 *
 * The CSP meta has to land inside `<head>` to be honoured, so a document that
 * brings its own head gets the tag inserted at the top of it rather than being
 * wrapped — wrapping would nest `<html>` inside `<html>` and the parser would
 * throw the outer one away, policy included.
 */
export function buildSandboxDocument(source: string): string {
  const headOpen = /<head\b[^>]*>/i.exec(source)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return (
      source.slice(0, at) + HEAD_INJECT + source.slice(at) + `\n<script>${BRIDGE_SCRIPT}</script>`
    )
  }
  // No head of its own: an <html> without one still parses correctly with the
  // metas hoisted ahead of it, and a bare fragment becomes a whole document.
  const htmlOpen = /<html\b[^>]*>/i.exec(source)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return (
      source.slice(0, at) +
      `<head>${HEAD_INJECT}</head>` +
      source.slice(at) +
      `\n<script>${BRIDGE_SCRIPT}</script>`
    )
  }
  return (
    `<!DOCTYPE html><html><head>${HEAD_INJECT}</head><body>` +
    source +
    `\n<script>${BRIDGE_SCRIPT}</script></body></html>`
  )
}

export interface BridgeSelection {
  text: string
  textOffset: number
  rect: { top: number; left: number; bottom: number; right: number; width: number; height: number }
}

export type BridgeMessage =
  | ({ source: 'krit-preview'; type: 'selection' } & Partial<BridgeSelection>)
  | { source: 'krit-preview'; type: 'height'; height: number }

/** Narrows an arbitrary `message` event payload to a bridge message. */
export function asBridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.source !== 'krit-preview') return null
  if (d.type === 'selection' || d.type === 'height') return d as BridgeMessage
  return null
}
