// Maps the visible text of an HTML file back to offsets in its source.
//
// The Markdown path gets source positions for free from remark, but an HTML
// artifact renders inside a sandboxed, opaque-origin iframe: the parent can
// neither read its DOM nor ask a parser where a node came from without
// shipping one. What it can do is scan the source once, emitting the text a
// browser would render alongside the source offset each character came from.
// The iframe's bridge reports a selection as an offset into the same text
// (its traversal rule matches the exclusions here), and the two line up.
//
// This holds exactly as long as the artifact's live DOM matches its source —
// true for static pages, false the moment its own scripts rewrite the body.
// Every caller therefore verifies the mapping against the selected text
// before trusting it and falls back to searching (see `locateSelection`);
// unlocatable is a supported outcome, not a bug. See the anchoring ladder in
// docs/design/rendered-preview.md.

export interface HtmlTextMap {
  /** Concatenated text of the source's rendered text nodes. */
  text: string
  /** `offsets[i]` is the source offset that produced `text[i]`. */
  offsets: number[]
}

// Contents are parsed as data, not markup, and are never rendered as text.
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'template', 'head', 'title'])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  copy: '©',
  reg: '®',
  trade: '™',
}

export function buildHtmlTextMap(source: string): HtmlTextMap {
  const chars: string[] = []
  const offsets: number[] = []

  // The bridge traverses `document.body`, so anything the parser puts outside
  // it must not be scanned here. That is mostly the newline a formatted
  // document has between `</head>` and `<body>`: it is real in the source,
  // absent from the DOM, and counting it shifts every later offset by one.
  const bodyOpen = /<body\b[^>]*>/i.exec(source)
  const bodyClose = source.toLowerCase().lastIndexOf('</body')
  let i = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0
  const end = bodyOpen && bodyClose > i ? bodyClose : source.length

  const emit = (value: string, at: number) => {
    for (const ch of value) {
      chars.push(ch)
      offsets.push(at)
    }
  }

  while (i < end) {
    const ch = source[i]

    if (ch === '<') {
      if (source.startsWith('<!--', i)) {
        const close = source.indexOf('-->', i + 4)
        i = close === -1 ? end : close + 3
        continue
      }
      // `<!DOCTYPE html>`, and any other `<!…>` or `<?…>`, which HTML parsers
      // treat as a doctype or a bogus comment. None of it renders. Missing
      // this shifts every offset in the document by the length of the doctype,
      // which is a silent wrong-anchor rather than a visible failure.
      if (source[i + 1] === '!' || source[i + 1] === '?') {
        const close = source.indexOf('>', i + 2)
        i = close === -1 ? end : close + 1
        continue
      }
      const tagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(source.slice(i))
      if (!tagMatch) {
        // A bare '<' that starts no tag is literal text in every parser.
        emit('<', i)
        i++
        continue
      }
      const name = tagMatch[1].toLowerCase()
      const isClosing = source[i + 1] === '/'
      const tagEnd = findTagEnd(source, i)

      if (!isClosing && RAW_TEXT_ELEMENTS.has(name)) {
        // Skip to the matching close tag; nothing between them is rendered
        // text, and the bridge's traversal skips the same elements.
        const closeIdx = indexOfClosingTag(source, name, tagEnd)
        i = closeIdx === -1 ? end : closeIdx
        continue
      }
      i = tagEnd
      continue
    }

    if (ch === '&') {
      const semi = source.indexOf(';', i + 1)
      if (semi > i && semi - i <= 10) {
        const body = source.slice(i + 1, semi)
        const decoded = decodeEntity(body)
        if (decoded != null) {
          emit(decoded, i)
          i = semi + 1
          continue
        }
      }
      emit('&', i)
      i++
      continue
    }

    emit(ch, i)
    i++
  }

  return { text: chars.join(''), offsets }
}

function decodeEntity(body: string): string | null {
  if (body.startsWith('#')) {
    const isHex = body[1] === 'x' || body[1] === 'X'
    const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
      try {
        return String.fromCodePoint(code)
      } catch {
        return null
      }
    }
    return null
  }
  return NAMED_ENTITIES[body] ?? null
}

/** Index just past the '>' closing the tag starting at `start`, quotes respected. */
function findTagEnd(source: string, start: number): number {
  let quote: string | null = null
  for (let j = start + 1; j < source.length; j++) {
    const c = source[j]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '>') return j + 1
  }
  return source.length
}

function indexOfClosingTag(source: string, name: string, from: number): number {
  const needle = `</${name}`
  const lower = source.toLowerCase()
  const at = lower.indexOf(needle, from)
  return at === -1 ? -1 : at
}

export interface LocatedSelection {
  startOffset: number
  endOffset: number
  /** False when the text offset the bridge reported did not match the source. */
  exact: boolean
}

/**
 * Resolves a selection reported by the iframe bridge to a source range.
 *
 * `textOffset` is where the iframe says the selection starts in its own text
 * traversal. It is treated as a hint, not as truth — an artifact whose scripts
 * rewrote the DOM reports offsets into a document that no longer matches its
 * source — so it is only used when the text there actually matches. Otherwise
 * the selected text is searched for, nearest the hint first, and a unique-
 * enough match wins. Returns null when the text cannot be found at all.
 */
export function locateSelection(
  map: HtmlTextMap,
  selectedText: string,
  textOffset: number,
): LocatedSelection | null {
  if (!selectedText) return null
  const span = (start: number, exact: boolean): LocatedSelection => {
    const last = Math.min(start + selectedText.length - 1, map.offsets.length - 1)
    return {
      startOffset: map.offsets[start],
      // Exclusive end: one past the source character that produced the last
      // selected character. Approximated as +1, which is right for every
      // character that isn't an entity and harmlessly short for those.
      endOffset: (map.offsets[last] ?? map.offsets[start]) + 1,
      exact,
    }
  }

  if (
    textOffset >= 0 &&
    textOffset < map.offsets.length &&
    map.text.startsWith(selectedText, textOffset)
  ) {
    return span(textOffset, true)
  }

  const first = map.text.indexOf(selectedText)
  if (first === -1) return null
  // Prefer the occurrence closest to where the iframe said it was; with a
  // mutated DOM the hint is still usually in the right neighbourhood.
  let best = first
  let bestDistance = Math.abs(first - textOffset)
  for (let at = map.text.indexOf(selectedText, first + 1); at !== -1; ) {
    const distance = Math.abs(at - textOffset)
    if (distance < bestDistance) {
      best = at
      bestDistance = distance
    }
    at = map.text.indexOf(selectedText, at + 1)
  }
  return span(best, false)
}
