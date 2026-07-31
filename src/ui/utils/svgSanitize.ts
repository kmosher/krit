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
const XLINK_NS = 'http://www.w3.org/1999/xlink'

/**
 * Elements that draw, group, define paint, or carry text.
 *
 * `a` and `use` are here, and are safe only because `safeAttributeValue`
 * confines every reference to a same-document fragment. Absent, and to stay
 * absent: `script`, `foreignObject` (arbitrary HTML, including iframes),
 * `image` (fetches), and the SMIL animation elements, which can set an
 * attribute after this code has finished vetting it.
 *
 * `style` is here but is admitted only on the generated-diagram path — see
 * `BuildOptions.allowStylesheets`.
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

/**
 * Elements whose content is not painted, so a selection in one means nothing.
 *
 * Kept in step with `NON_RENDERED_TEXT` in `previewAnchor.ts`, which asks the
 * same question of the rendered DOM. That set is the larger of the two because
 * it also covers HTML; the elements it names and this one doesn't (`script`,
 * `metadata`) cannot survive the allowlist above to reach here.
 */
const NON_RENDERING = new Set(['title', 'desc', 'style', 'defs'])

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
  /**
   * Whether `<style>` survives. True only for SVG this process generated —
   * Mermaid's and Graphviz's own stylesheets, which are engine output scoped
   * to the diagram's id, not markup from the file under review.
   *
   * It is false for a `.svg` file because CSS cannot be filtered by pattern
   * and must not be trusted unfiltered. Both of the obvious gates leak:
   * `@import` and `url()` are matched as literal substrings, while CSS
   * resolves escapes before tokenizing, so `@\69 mport` and `\75 rl(...)` are
   * the same declarations spelled past the filter, and `image-set()` fetches
   * with no `url(` token at all. Worse, an inline `<style>` is *not* scoped to
   * the picture — it joins the page's stylesheets and can restyle krit's own
   * controls. A reviewed file gets its presentation attributes, which is what
   * hand-written and tool-written SVG mostly uses, and the dropped `<style>`
   * is named on screen so an unstyled render doesn't look like the real thing.
   */
  allowStylesheets?: boolean
}

export function buildSvgDom(
  source: XmlElement,
  doc: Document,
  options: BuildOptions = {},
): BuildResult {
  const removed: string[] = []
  if (!isSvgRoot(source)) return { root: null, removed }
  const root = buildElement(source, doc, removed, {
    stampOffsets: options.stampOffsets ?? true,
    allowStylesheets: options.allowStylesheets ?? false,
  })
  return { root: root as SVGElement | null, removed }
}

/**
 * The name without any namespace prefix. Prefixed SVG (`<svg:svg>`, from some
 * generators) is ordinary SVG, and matching on the qualified name would reject
 * the whole document as unreadable rather than render it.
 */
export function localName(name: string): string {
  const colon = name.lastIndexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

function buildElement(
  node: XmlElement,
  doc: Document,
  removed: string[],
  options: Required<BuildOptions>,
): Element | null {
  const name = localName(node.name)
  if (!ALLOWED_ELEMENTS.has(name) || (name === 'style' && !options.allowStylesheets)) {
    removed.push(name)
    return null
  }
  const el = doc.createElementNS(SVG_NS, name)
  for (const attr of node.attributes) {
    const value = safeAttributeValue(attr.name, attr.value)
    if (value == null) continue
    // `xmlns` declarations are the DOM's to set; re-setting them as plain
    // attributes is at best noise.
    if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) continue
    try {
      if (localName(attr.name).toLowerCase() === 'href' && attr.name.includes(':')) {
        el.setAttributeNS(XLINK_NS, 'href', value)
      } else {
        el.setAttribute(attr.name, value)
      }
    } catch {
      // An attribute name the DOM rejects is one nothing needs.
    }
  }
  // The stamp `previewAnchor` reads, and the marker `SvgPreview` sets. Both
  // are written *after* the attribute loop, and the loop refuses to copy any
  // `data-*` from the source — otherwise a file could stamp itself and point a
  // reviewer's comment at a range they never selected, or mark arbitrary parts
  // of the picture as diff-touched. This is the whole anchoring contract: the
  // renderer owns `data-src`, not the file.
  if (options.stampOffsets && !NON_RENDERING.has(name)) {
    el.setAttribute('data-src', `${node.start}-${node.end}`)
  }

  for (const child of node.children) {
    if (child.kind === 'text') {
      el.appendChild(doc.createTextNode(child.value))
      continue
    }
    const built = buildElement(child, doc, removed, options)
    if (built) el.appendChild(built)
  }
  return el
}

/** Null to drop the attribute entirely. */
export function safeAttributeValue(name: string, value: string): string | null {
  const lower = name.toLowerCase()
  const local = localName(lower)
  if (local.startsWith('on')) return null
  // The renderer owns these; a file supplying its own would be believed.
  if (local.startsWith('data-')) return null
  // Every reference is confined to a same-document fragment, which is what
  // `use`, `clip-path` and `fill="url(#g)"` actually need. Matched on the
  // local name so a document that binds xlink to some other prefix goes
  // through the same gate.
  if (local === 'href') return value.startsWith('#') ? value : null
  // A base URI would re-point every fragment above at another origin, turning
  // the gate into a no-op without touching any value it checks.
  if (local === 'base') return null
  // `url(...)` in a presentation attribute is the same escape hatch as `href`:
  // a fragment paints with something already in this document, anything else
  // is a fetch. `style=` runs through here too, and is subject to the same
  // limits described on `allowStylesheets` — it is kept because a single
  // element's inline declarations cannot restyle anything but that element.
  if (/url\(/i.test(value) && !/url\(\s*['"]?#/i.test(value)) return null
  if (/(javascript|data|vbscript):/i.test(value)) return null
  return value
}

/** Whether the parsed tree is an SVG document at all. */
export function isSvgRoot(node: XmlNode | null): node is XmlElement {
  return node?.kind === 'element' && localName(node.name) === 'svg'
}
