import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  asBridgeMessage,
  buildSandboxDocument,
  BRIDGE_SCRIPT,
  visibleTextOffsetOf,
} from './htmlSandbox'
import { buildHtmlTextMap, locateSelection } from './htmlTextMap'

describe('buildSandboxDocument', () => {
  const cspOf = (doc: string) =>
    /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1] ?? null

  it('puts the policy at the top of an existing head, ahead of the page\'s own', () => {
    const source =
      '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><title>T</title></head><body>hi</body></html>'
    const doc = buildSandboxDocument(source)
    // First policy wins per spec, so ours has to come first to override.
    expect(cspOf(doc)).toContain("connect-src 'none'")
    expect(doc.indexOf("connect-src 'none'")).toBeLessThan(doc.indexOf('default-src *'))
  })

  it('gives an <html> with no head one, rather than nesting a document', () => {
    const doc = buildSandboxDocument('<html><body>hi</body></html>')
    expect(cspOf(doc)).toContain("connect-src 'none'")
    expect(doc.match(/<html/gi)).toHaveLength(1)
  })

  it('wraps a bare fragment into a whole document', () => {
    const doc = buildSandboxDocument('<p>just a fragment</p>')
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(doc).toContain('<p>just a fragment</p>')
    expect(cspOf(doc)).toContain("connect-src 'none'")
  })

  it('always injects the bridge, whichever shape the document had', () => {
    for (const source of [
      '<!DOCTYPE html><html><head></head><body>a</body></html>',
      '<html><body>b</body></html>',
      '<p>c</p>',
    ]) {
      expect(buildSandboxDocument(source)).toContain(BRIDGE_SCRIPT)
    }
  })

  it('blocks the network and every remote subresource', () => {
    const csp = cspOf(buildSandboxDocument('<p>x</p>'))!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("form-action 'none'")
    // Inline script and style stay allowed: a self-contained artifact is
    // nothing but inline script and style, and the sandbox attribute — not
    // this policy — is what keeps it away from krit's origin.
    expect(csp).toContain("script-src 'unsafe-inline'")
    // Images may only come from the document itself.
    expect(csp).toContain('img-src data: blob:')
    expect(csp).not.toContain('img-src *')
  })

  it('preserves the artifact byte-for-byte apart from the injections', () => {
    const body = '<p>Some &amp; content <em>here</em></p>'
    expect(buildSandboxDocument(`<html><head></head><body>${body}</body></html>`)).toContain(body)
  })
})

// The iframe reports offsets into a string it never sees; the parent resolves
// them against a string it built by scanning the source. If those two
// traversals ever disagree about what counts as visible text, every HTML
// anchor silently lands in the wrong place — and the sandbox makes that
// impossible to catch from the outside. These pin the agreement directly.
describe('bridge / source-scan agreement', () => {
  const SAMPLE = [
    '<!DOCTYPE html><html><head><title>Ignored</title>',
    '<style>p { color: red }</style></head>',
    '<body><h1>Report</h1>',
    '<p>Revenue grew by <strong>eighteen percent</strong> this quarter.</p>',
    '<div class="metric">Uptime: 99.94%</div>',
    '<script>var hidden = "not text"</script>',
    '</body></html>',
  ].join('\n')

  /** The live DOM a browser would build from SAMPLE. */
  function parsed(): Document {
    return new DOMParser().parseFromString(SAMPLE, 'text/html')
  }

  function findText(root: Node, value: string): Text {
    const walk = (n: Node): Text | null => {
      if (n.nodeType === 3 && (n.nodeValue ?? '').includes(value)) return n as Text
      for (let c = n.firstChild; c; c = c.nextSibling) {
        const hit = walk(c)
        if (hit) return hit
      }
      return null
    }
    const found = walk(root)
    if (!found) throw new Error(`no text node containing ${value}`)
    return found
  }

  it('agrees on the offset of a run, so a reported selection resolves exactly', () => {
    const doc = parsed()
    const map = buildHtmlTextMap(SAMPLE)
    const node = findText(doc.body, 'eighteen percent')

    const reported = visibleTextOffsetOf(doc.body, node, 0)
    expect(reported).toBeGreaterThanOrEqual(0)
    // The offset the iframe would report indexes the parent's text at the
    // same run — this is the whole contract.
    expect(map.text.startsWith('eighteen percent', reported)).toBe(true)

    const located = locateSelection(map, 'eighteen percent', reported)!
    expect(located.exact).toBe(true)
    expect(SAMPLE.slice(located.startOffset, located.endOffset)).toBe('eighteen percent')
  })

  it('agrees that script, style and title contribute no text', () => {
    const doc = parsed()
    const map = buildHtmlTextMap(SAMPLE)
    // Neither side may count these; if one did, every later offset shifts.
    expect(map.text).not.toContain('not text')
    expect(map.text).not.toContain('color: red')
    expect(map.text).not.toContain('Ignored')

    const afterScript = findText(doc.body, 'Uptime')
    const reported = visibleTextOffsetOf(doc.body, afterScript, 0)
    expect(map.text.startsWith('Uptime', reported)).toBe(true)
  })

  it('agrees for every text run in the document, not just the sampled ones', () => {
    const doc = parsed()
    const map = buildHtmlTextMap(SAMPLE)
    const runs: Text[] = []
    const collect = (n: Node) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) runs.push(c as Text)
        else if (c.nodeType === 1 && !['SCRIPT', 'STYLE'].includes((c as Element).tagName))
          collect(c)
      }
    }
    collect(doc.body)
    for (const run of runs) {
      const value = run.nodeValue ?? ''
      if (!value.trim()) continue
      const reported = visibleTextOffsetOf(doc.body, run, 0)
      expect({ value, at: map.text.slice(reported, reported + value.length) }).toEqual({
        value,
        at: value,
      })
    }
  })

  it('serialises the shared traversal into the bridge rather than duplicating it', () => {
    // The bridge must carry this exact function; a hand-written second copy is
    // what would let the two halves drift apart unnoticed.
    expect(BRIDGE_SCRIPT).toContain(visibleTextOffsetOf.toString())
  })
})

// The bridge can only be reached by running it. Automation cannot deliver
// input into a sandboxed, opaque-origin iframe — a real Chrome confirmed the
// script loads and posts (height messages arrive tagged `fromFrame`), but
// neither a synthetic drag nor a keystroke reaches the frame's document, and
// the artifact's own click handlers stay dead too. So the script is executed
// here against a document instead: everything except the browser's own
// selection geometry is under test, and geometry is not krit's code.
describe('BRIDGE_SCRIPT, executed', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const PAGE =
    '<h1>Report</h1>' +
    '<p>Revenue grew by <strong>eighteen percent</strong> this quarter.</p>' +
    '<script>var ignored = 1</script>'

  function runBridge() {
    document.body.innerHTML = PAGE
    const posted: unknown[] = []
    // The bridge talks to its embedder; stand in for it.
    const fakeParent = { postMessage: (msg: unknown) => posted.push(msg) }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('parent', 'document', 'window', BRIDGE_SCRIPT)(fakeParent, document, window)
    return posted
  }

  it('parses and runs, and reports a selection with a resolvable offset', () => {
    const posted = runBridge()
    const strong = document.querySelector('strong')!
    const node = strong.firstChild as Text

    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, node.nodeValue!.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    vi.runAllTimers()

    const selection = posted.find(
      (m) => (m as { type: string }).type === 'selection',
    ) as { text: string; textOffset: number } | undefined
    expect(selection).toBeDefined()
    expect(selection!.text).toBe('eighteen percent')

    // The reported offset must index the parent's independently-built map.
    const map = buildHtmlTextMap(PAGE)
    const located = locateSelection(map, selection!.text, selection!.textOffset)!
    expect(located.exact).toBe(true)
    expect(PAGE.slice(located.startOffset, located.endOffset)).toBe('eighteen percent')
  })

  it('reports an empty selection rather than going silent, so the pill clears', () => {
    const posted = runBridge()
    window.getSelection()!.removeAllRanges()
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    vi.runAllTimers()
    const selection = posted.find((m) => (m as { type: string }).type === 'selection') as
      | { text: string }
      | undefined
    expect(selection).toEqual(expect.objectContaining({ text: '' }))
  })

  it('tags everything it sends so the embedder can filter the window channel', () => {
    const posted = runBridge()
    vi.runAllTimers()
    expect(posted.length).toBeGreaterThan(0)
    for (const msg of posted) {
      expect(asBridgeMessage(msg)).not.toBeNull()
    }
  })
})

describe('asBridgeMessage', () => {
  it('accepts the two message shapes the bridge sends', () => {
    expect(asBridgeMessage({ source: 'krit-preview', type: 'height', height: 10 })).toBeTruthy()
    expect(asBridgeMessage({ source: 'krit-preview', type: 'selection', text: 'x' })).toBeTruthy()
  })

  it('rejects anything else on the window message channel', () => {
    // A page shares its window with whatever else posts to the opener, so the
    // tag is checked before the payload is read.
    expect(asBridgeMessage({ type: 'selection', text: 'x' })).toBeNull()
    expect(asBridgeMessage({ source: 'other-extension', type: 'selection' })).toBeNull()
    expect(asBridgeMessage({ source: 'krit-preview', type: 'navigate' })).toBeNull()
    expect(asBridgeMessage(null)).toBeNull()
    expect(asBridgeMessage('krit-preview')).toBeNull()
  })
})
