import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@uiw/react-codemirror'

// Colors lifted from @pierre/theme's pierre-light / pierre-dark Shiki themes
// (used by the diff viewer). Keeping them in this file means the editor and
// the diff surface stay in visual sync without depending on Shiki here.
const light = {
  comment: '#737373',
  string: '#199f43',
  number: '#1ca1c7',
  bool: '#1ca1c7',
  constant: '#d5a910',
  keyword: '#d32a61',
  variable: '#d47628',
  parameter: '#636363',
  func: '#693acf',
  type: '#a631be',
  operator: '#636363',
  arithOperator: '#08c0ef',
} as const

const dark = {
  comment: '#737373',
  string: '#5ecc71',
  number: '#68cdf2',
  bool: '#68cdf2',
  constant: '#ffd452',
  keyword: '#ff678d',
  variable: '#ffa359',
  parameter: '#a3a3a3',
  func: '#9d6afb',
  type: '#d568ea',
  operator: '#636363',
  arithOperator: '#08c0ef',
} as const

type Palette = { [K in keyof typeof light]: string }

function build(p: Palette) {
  return HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment, fontStyle: 'italic' },
    { tag: [t.string, t.special(t.string), t.regexp], color: p.string },
    { tag: t.number, color: p.number },
    { tag: t.bool, color: p.bool },
    { tag: t.atom, color: p.constant },
    { tag: [t.keyword, t.controlKeyword, t.modifier, t.definitionKeyword, t.moduleKeyword], color: p.keyword },
    { tag: t.operatorKeyword, color: p.keyword },
    { tag: t.self, color: p.constant },
    { tag: [t.variableName, t.propertyName], color: p.variable },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: p.func },
    { tag: [t.typeName, t.className, t.namespace], color: p.type },
    { tag: t.operator, color: p.operator },
    { tag: [t.logicOperator, t.arithmeticOperator, t.bitwiseOperator, t.compareOperator], color: p.arithOperator },
    { tag: t.punctuation, color: p.operator },
    { tag: t.meta, color: p.comment },
    { tag: t.invalid, color: '#d52c36' },
  ])
}

const lightStyle = build(light)
const darkStyle = build(dark)

// Returns the highlight extension matching the active scheme. We pick in JS
// rather than relying on HighlightStyle's themeType because nothing in our
// editor wiring sets EditorView.darkTheme, so themeType:'dark' would never
// activate.
export function pierreSyntaxHighlighting(scheme: 'light' | 'dark'): Extension {
  return syntaxHighlighting(scheme === 'dark' ? darkStyle : lightStyle)
}
