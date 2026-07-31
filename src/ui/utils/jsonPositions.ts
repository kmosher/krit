// A JSON parser that keeps every value's source offsets, and — for strings —
// where each decoded character came from.
//
// `JSON.parse` is not enough for a notebook preview. A cell's text lives inside
// string literals, so anchoring a comment on rendered cell content means
// knowing which file offset each decoded character sits at, and escapes make
// that non-linear: `\n` is two source characters for one decoded one, `\uXXXX`
// is six. Hence `map`, which the notebook path composes with the offsets the
// Markdown renderer stamps.

export type JsonNode =
  | { kind: 'string'; value: string; start: number; end: number; map: number[] }
  | { kind: 'number'; value: number; start: number; end: number }
  | { kind: 'boolean'; value: boolean; start: number; end: number }
  | { kind: 'null'; value: null; start: number; end: number }
  | { kind: 'array'; items: JsonNode[]; start: number; end: number }
  | { kind: 'object'; entries: Map<string, JsonNode>; start: number; end: number }

/**
 * Returns null for anything that isn't well-formed JSON — a caller with an
 * unparseable file has no preview to render and should say so, not guess.
 */
export function parseJsonWithPositions(text: string): JsonNode | null {
  let i = 0

  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++
  }

  const fail = () => {
    throw new SyntaxError(`unexpected ${JSON.stringify(text[i] ?? '<eof>')} at ${i}`)
  }

  const expect = (ch: string) => {
    if (text[i] !== ch) fail()
    i++
  }

  const parseString = (): Extract<JsonNode, { kind: 'string' }> => {
    const start = i
    expect('"')
    let value = ''
    // One entry per decoded character, plus a trailing entry for the position
    // just past the last one, so an exclusive end offset translates too.
    const map: number[] = []
    while (true) {
      if (i >= text.length) fail()
      const ch = text[i]
      if (ch === '"') {
        map.push(i)
        i++
        break
      }
      if (ch === '\\') {
        const at = i
        i++
        const esc = text[i]
        i++
        if (esc === 'u') {
          const hex = text.slice(i, i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail()
          value += String.fromCharCode(parseInt(hex, 16))
          i += 4
        } else {
          const simple = SIMPLE_ESCAPES[esc as keyof typeof SIMPLE_ESCAPES]
          if (simple == null) fail()
          value += simple
        }
        map.push(at)
        continue
      }
      map.push(i)
      value += ch
      i++
    }
    return { kind: 'string', value, start, end: i, map }
  }

  const parseValue = (): JsonNode => {
    ws()
    const start = i
    const ch = text[i]
    if (ch === '"') return parseString()
    if (ch === '{') {
      i++
      const entries = new Map<string, JsonNode>()
      ws()
      if (text[i] === '}') {
        i++
        return { kind: 'object', entries, start, end: i }
      }
      while (true) {
        ws()
        const key = parseString()
        ws()
        expect(':')
        entries.set(key.value, parseValue())
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        expect('}')
        break
      }
      return { kind: 'object', entries, start, end: i }
    }
    if (ch === '[') {
      i++
      const items: JsonNode[] = []
      ws()
      if (text[i] === ']') {
        i++
        return { kind: 'array', items, start, end: i }
      }
      while (true) {
        items.push(parseValue())
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        expect(']')
        break
      }
      return { kind: 'array', items, start, end: i }
    }
    if (text.startsWith('true', i)) {
      i += 4
      return { kind: 'boolean', value: true, start, end: i }
    }
    if (text.startsWith('false', i)) {
      i += 5
      return { kind: 'boolean', value: false, start, end: i }
    }
    if (text.startsWith('null', i)) {
      i += 4
      return { kind: 'null', value: null, start, end: i }
    }
    const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))
    if (num) {
      i += num[0].length
      return { kind: 'number', value: Number(num[0]), start, end: i }
    }
    return fail() as never
  }

  try {
    const root = parseValue()
    ws()
    if (i !== text.length) return null
    return root
  } catch {
    return null
  }
}

const SIMPLE_ESCAPES = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
} as const

export function objectField(node: JsonNode | undefined, key: string): JsonNode | undefined {
  return node?.kind === 'object' ? node.entries.get(key) : undefined
}

/** A JSON string value, or null if the node is any other kind. */
export function stringValue(node: JsonNode | undefined): string | null {
  return node?.kind === 'string' ? node.value : null
}
