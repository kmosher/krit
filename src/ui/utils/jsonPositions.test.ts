import { describe, expect, it } from 'vitest'
import { objectField, parseJsonWithPositions, stringValue } from './jsonPositions'

describe('parseJsonWithPositions', () => {
  it('agrees with JSON.parse on values', () => {
    const text = '{"a": [1, -2.5e3, true, false, null], "b": {"c": "x"}}'
    const node = parseJsonWithPositions(text)!
    expect(toPlain(node)).toEqual(JSON.parse(text))
  })

  it('rejects malformed input rather than guessing', () => {
    for (const bad of ['{', '{"a": }', '[1,]', '"unterminated', '{"a":1} trailing', '']) {
      expect(parseJsonWithPositions(bad)).toBeNull()
    }
  })

  it('spans a value from its first character to just past its last', () => {
    const text = '{"a": "hi"}'
    const a = objectField(parseJsonWithPositions(text)!, 'a')!
    expect(text.slice(a.start, a.end)).toBe('"hi"')
  })

  it('maps each decoded character back to where it was written', () => {
    //             0123456789
    const text = '"a\\nb\\u0041c"'
    const node = parseJsonWithPositions(text)!
    expect(stringValue(node)).toBe('a\nbAc')
    if (node.kind !== 'string') throw new Error('expected a string')
    // Every decoded character points at the first character of what produced
    // it — the backslash for an escape — and the trailing entry at the quote.
    expect(node.map).toEqual([1, 2, 4, 5, 11, 12])
    expect(text[node.map[1]]).toBe('\\')
    expect(text[node.map[node.map.length - 1]]).toBe('"')
  })

  it('maps a plain string one-to-one', () => {
    const node = parseJsonWithPositions('"abc"')!
    if (node.kind !== 'string') throw new Error('expected a string')
    expect(node.map).toEqual([1, 2, 3, 4])
  })
})

function toPlain(node: ReturnType<typeof parseJsonWithPositions>): unknown {
  if (!node) return undefined
  if (node.kind === 'array') return node.items.map(toPlain)
  if (node.kind === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of node.entries) out[k] = toPlain(v)
    return out
  }
  return node.value
}
