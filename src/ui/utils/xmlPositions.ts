// An XML parser that keeps every element's source offsets, for the SVG
// preview.
//
// `DOMParser` would be shorter but gives no positions, and positions are the
// whole point: `previewAnchor.ts` anchors a comment by reading a `data-src`
// stamp off the element a selection landed in. It also hands back a live tree
// that would have to be adopted into the page, which is exactly the thing the
// renderer avoids doing — see `SvgPreview`, which builds React elements from
// this tree through an allowlist instead.

export interface XmlElement {
  kind: 'element'
  name: string
  attributes: Array<{ name: string; value: string }>
  children: XmlNode[]
  /** File offsets of the whole element, opening `<` through closing `>`. */
  start: number
  end: number
}

export interface XmlText {
  kind: 'text'
  value: string
  start: number
  end: number
}

export type XmlNode = XmlElement | XmlText

/** Null for input that isn't well-formed enough to render. */
export function parseXml(source: string): XmlElement | null {
  let i = 0
  const stack: XmlElement[] = []
  let root: XmlElement | null = null

  const pushText = (value: string, start: number, end: number) => {
    const parent = stack[stack.length - 1]
    if (!parent || !value) return
    parent.children.push({ kind: 'text', value: decodeEntities(value), start, end })
  }

  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt < 0) {
      pushText(source.slice(i), i, source.length)
      break
    }
    if (lt > i) pushText(source.slice(i, lt), i, lt)

    // Declarations, processing instructions and comments carry no rendered
    // text; skipping them wholesale also skips their `>`-containing content.
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt)
      if (close < 0) return null
      i = close + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const close = source.indexOf(']]>', lt)
      if (close < 0) return null
      pushText(source.slice(lt + 9, close), lt + 9, close)
      i = close + 3
      continue
    }
    if (source[lt + 1] === '?' || source[lt + 1] === '!') {
      const close = source.indexOf('>', lt)
      if (close < 0) return null
      i = close + 1
      continue
    }

    if (source[lt + 1] === '/') {
      const close = source.indexOf('>', lt)
      if (close < 0) return null
      const name = source.slice(lt + 2, close).trim()
      const open = stack.pop()
      if (!open || open.name !== name) return null
      open.end = close + 1
      i = close + 1
      if (stack.length === 0) {
        // Content after the root element closes is not well-formed XML, but
        // trailing whitespace is, and files end with a newline.
        if (source.slice(i).trim()) return null
        break
      }
      continue
    }

    const tag = readTag(source, lt)
    if (!tag) return null
    const el: XmlElement = {
      kind: 'element',
      name: tag.name,
      attributes: tag.attributes,
      children: [],
      start: lt,
      end: tag.end,
    }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(el)
    else if (root) return null
    else root = el
    if (!tag.selfClosing) stack.push(el)
    i = tag.end
  }

  return stack.length === 0 ? root : null
}

function readTag(
  source: string,
  at: number,
): { name: string; attributes: Array<{ name: string; value: string }>; selfClosing: boolean; end: number } | null {
  let i = at + 1
  const nameStart = i
  while (i < source.length && !/[\s/>]/.test(source[i])) i++
  const name = source.slice(nameStart, i)
  if (!name) return null

  const attributes: Array<{ name: string; value: string }> = []
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++
    if (source[i] === '>') return { name, attributes, selfClosing: false, end: i + 1 }
    if (source[i] === '/' && source[i + 1] === '>') {
      return { name, attributes, selfClosing: true, end: i + 2 }
    }
    const keyStart = i
    while (i < source.length && !/[\s=/>]/.test(source[i])) i++
    const key = source.slice(keyStart, i)
    if (!key) return null
    while (i < source.length && /\s/.test(source[i])) i++
    if (source[i] !== '=') {
      attributes.push({ name: key, value: key })
      continue
    }
    i++
    while (i < source.length && /\s/.test(source[i])) i++
    const quote = source[i]
    if (quote !== '"' && quote !== "'") return null
    const valueStart = ++i
    const close = source.indexOf(quote, i)
    if (close < 0) return null
    attributes.push({ name: key, value: decodeEntities(source.slice(valueStart, close)) })
    i = close + 1
  }
  return null
}

// Only the five predefined entities plus numeric references. An SVG using a
// DTD-declared entity is beyond what this renders, and leaving an unknown
// reference as written is the honest outcome.
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    return named[body] ?? whole
  })
}
