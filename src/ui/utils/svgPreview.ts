// Turns parsed SVG source into real SVG DOM, stamped with source offsets and
// stripped of everything that could execute or fetch.
//
// Inline SVG is live markup in this page's origin, not a picture: `<script>`,
// `on*` handlers, `<foreignObject>` and any external reference are all script
// or network from a file under review. So the tree is rebuilt element by
// element through an allowlist with `createElementNS` — never `innerHTML`,
// which would hand the browser the original markup and rely on the allowlist
// being complete.
//
// The HTML preview solves the same problem the other way, with an opaque-origin
// iframe. SVG does not need that: an artifact is a program and has to keep its
// scripts to be worth previewing, while an SVG that needs a script is not a
// diagram anyone is reviewing as one.

import type { XmlElement, XmlNode } from './xmlPositions'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Elements that draw, group, define paint, or carry text. Notably absent:
 * `script`, `foreignObject` (arbitrary HTML, including iframes), `image` and
 * `use`'s external form (both fetch), and the `<a>` element.
 */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'style', 'a',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern',
  'clipPath', 'mask', 'marker',
  'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix',
  'feComposite', 'feFlood', 'feMerge', 'feMergeNode', 'feDropShadow',
])

/** Elements whose content is not painted, so a selection in one means nothing. */
const NON_RENDERING = new Set(['title', 'desc', 'style', 'defs'])

/**
 * Attribute names that may reference something outside the document. Each is
 * allowed only as a same-document fragment (`#id`), which is what `use`,
 * `clip-path`, `fill="url(#g)"` and friends actually need.
 */
const REFERENCE_ATTRIBUTES = new Set(['href', 'xlink:href'])

export interface BuildResult {
  root: SVGElement | null
  /** Names dropped by the allowlist, for telling the reader what was removed. */
  removed: string[]
}

export interface BuildOptions {
  /**
   * Whether elements carry their own source offsets. False for a diagram
   * rendered from Mermaid or Graphviz source: the offsets in *that* SVG
   * describe markup no one is reviewing, and stamping them would anchor
   * comments into a string that exists only in memory. Those previews stamp
   * one span around the whole picture instead, and let the locate-by-value
   * rule find the selected label in the diagram's real source.
   */
  stampOffsets?: boolean
}

export function buildSvgDom(
  source: XmlElement,
  doc: Document,
  options: BuildOptions = {},
): BuildResult {
  const removed: string[] = []
  if (source.name !== 'svg') return { root: null, removed }
  const root = buildElement(source, doc, removed, options.stampOffsets ?? true)
  return { root: root as SVGElement | null, removed }
}

function buildElement(
  node: XmlElement,
  doc: Document,
  removed: string[],
  stampOffsets: boolean,
): Element | null {
  if (!ALLOWED_ELEMENTS.has(node.name)) {
    removed.push(node.name)
    return null
  }
  const el = doc.createElementNS(SVG_NS, node.name)
  for (const attr of node.attributes) {
    const value = safeAttributeValue(attr.name, attr.value)
    if (value == null) continue
    // `xmlns` and `xlink:` are namespace declarations the DOM sets itself;
    // re-setting them as plain attributes is at best noise.
    if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) continue
    try {
      if (attr.name === 'xlink:href') {
        el.setAttributeNS('http://www.w3.org/1999/xlink', 'href', value)
      } else {
        el.setAttribute(attr.name, value)
      }
    } catch {
      // An attribute name the DOM rejects is one nothing needs.
    }
  }
  // The stamp `previewAnchor` reads. Not set on non-rendering elements: their
  // text is never on screen, so an anchor into one could only come from a
  // mis-hit, and a missing stamp makes that yield nothing instead.
  if (stampOffsets && !NON_RENDERING.has(node.name)) {
    el.setAttribute('data-src', `${node.start}-${node.end}`)
  }

  for (const child of node.children) {
    if (child.kind === 'text') {
      if (node.name === 'style' && !isSafeStylesheet(child.value)) continue
      el.appendChild(doc.createTextNode(child.value))
      continue
    }
    const built = buildElement(child, doc, removed, stampOffsets)
    if (built) el.appendChild(built)
  }
  return el
}

/** Null to drop the attribute entirely. */
export function safeAttributeValue(name: string, value: string): string | null {
  const lower = name.toLowerCase()
  if (lower.startsWith('on')) return null
  if (REFERENCE_ATTRIBUTES.has(lower)) return value.startsWith('#') ? value : null
  // `url(...)` in a presentation attribute is the same escape hatch as `href`:
  // a fragment paints with something already in this document, anything else
  // is a fetch.
  if (/url\(/i.test(value) && !/url\(\s*['"]?#/i.test(value)) return null
  if (/(javascript|data|vbscript):/i.test(value)) return null
  return value
}

/**
 * A stylesheet may style, but may not reach out. `@import` and `url()` are the
 * only two ways it can, and an SVG whose classes need neither is the common
 * case — so filtering keeps ordinary styled diagrams rendering correctly
 * rather than dropping `<style>` outright and showing an unstyled one.
 */
export function isSafeStylesheet(css: string): boolean {
  return !/@import/i.test(css) && !/url\(/i.test(css)
}

/** Whether the parsed tree is an SVG document at all. */
export function isSvgRoot(node: XmlNode | null): node is XmlElement {
  return node?.kind === 'element' && node.name === 'svg'
}
