import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { C, FONT } from '../theme'

// Chrome (background, gutter, cursor, selection) mapped to the app's warm-dark
// tokens; token colors use the one-dark palette, inlined below so the editor
// carries no theme package. `selection` uses the same value the xterm panes use.
const chrome = EditorView.theme(
  {
    '&': { color: C.text, backgroundColor: C.bg, height: '100%', fontSize: '13px' },
    '.cm-scroller': { fontFamily: FONT, lineHeight: '1.55' },
    '.cm-content': { caretColor: C.accent },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: C.accent },
    '&.cm-focused .cm-cursor': { borderLeftColor: C.accent },
    '.cm-gutters': { backgroundColor: C.bg, color: C.dim, border: 'none' },
    '.cm-activeLine': { backgroundColor: C.hover },
    '.cm-activeLineGutter': { backgroundColor: C.hover, color: C.muted },
    '.cm-foldPlaceholder': { backgroundColor: C.panel2, color: C.muted, border: 'none' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(217,119,87,0.3)',
    },
    '.cm-selectionMatch': { backgroundColor: 'rgba(217,119,87,0.18)' },
    '.cm-panels': { backgroundColor: C.panel, color: C.text },
    '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${C.border2}` },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(217,119,87,0.24)',
      outline: `1px solid ${C.accentBorder}`,
    },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(217,119,87,0.42)' },
    '.cm-textfield': {
      backgroundColor: C.input,
      color: C.textHi,
      border: `1px solid ${C.border3}`,
    },
    '.cm-button': { backgroundColor: C.input, color: C.text, border: `1px solid ${C.border3}` },
  },
  { dark: true },
)

// One-dark token palette, inlined so the editor does not depend on the
// @codemirror/theme-one-dark package (MIT, CodeMirror).
const chalky = '#e5c07b'
const coral = '#e06c75'
const cyan = '#56b6c2'
const invalid = '#ffffff'
const ivory = '#abb2bf'
const stone = '#7d8799'
const malibu = '#61afef'
const sage = '#98c379'
const whiskey = '#d19a66'
const violet = '#c678dd'

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: violet },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: coral },
  { tag: [t.function(t.variableName), t.labelName], color: malibu },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: whiskey },
  { tag: [t.definition(t.name), t.separator], color: ivory },
  {
    tag: [
      t.typeName,
      t.className,
      t.number,
      t.changed,
      t.annotation,
      t.modifier,
      t.self,
      t.namespace,
    ],
    color: chalky,
  },
  {
    tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)],
    color: cyan,
  },
  { tag: [t.meta, t.comment], color: stone },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: stone, textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: coral },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: whiskey },
  { tag: [t.processingInstruction, t.string, t.inserted], color: sage },
  { tag: t.invalid, color: invalid },
])

export const editorTheme: Extension = [chrome, syntaxHighlighting(highlight)]
