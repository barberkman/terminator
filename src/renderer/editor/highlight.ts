import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { C } from '../theme'

// Token colors hand-tuned to the app's warm-dark palette (rather than borrowing
// one-dark's cool blues, which read as muted on C.bg). Greens/golds/ambers keep
// syntax legible while the accent orange carries keywords, matching the chrome.
// Kept free of @codemirror/view so it stays DOM-independent (and unit-testable).
export const warmHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: C.accent },
  { tag: [t.self, t.null, t.atom, t.bool, t.number, t.integer, t.float, t.unit], color: '#d9a35b' },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue, t.inserted], color: '#9bb06d' },
  { tag: [t.regexp, t.escape], color: '#e0916f' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: C.dim, fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: '#e0b57a' },
  { tag: [t.propertyName, t.attributeName], color: '#c9b79c' },
  { tag: [t.typeName, t.className, t.namespace, t.changed], color: '#d9c07a' },
  { tag: [t.tagName, t.angleBracket], color: C.accent },
  { tag: [t.constant(t.variableName), t.standard(t.name), t.macroName], color: C.accentSoft },
  { tag: [t.variableName], color: C.text },
  {
    tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator, t.definitionOperator, t.punctuation, t.separator, t.bracket, t.brace, t.paren, t.squareBracket],
    color: C.body,
  },
  { tag: [t.meta, t.documentMeta, t.processingInstruction, t.annotation], color: C.muted },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: C.textHi, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: C.accentSoft, textDecoration: 'underline' },
  { tag: t.url, color: '#9bb06d' },
  { tag: [t.deleted, t.invalid], color: C.danger },
])
