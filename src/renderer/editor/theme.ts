import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { C, FONT, accentA, ink } from '../theme'

// Chrome and token colours are written as `var(--c-*)` references, the same way
// the app chrome is: CodeMirror emits them into stylesheet rules, so a theme
// switch repaints every open editor with no reconfiguration. The one thing that
// can't be a variable is the `dark` flag — it's baked in at construction and
// drives CodeMirror's own defaults (panels, tooltips, caret contrast) — so the
// theme lives in a Compartment that registry.ts reconfigures on a theme change.
function chrome(dark: boolean): Extension {
  return EditorView.theme(
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
        backgroundColor: accentA(0.3),
      },
      '.cm-selectionMatch': { backgroundColor: accentA(0.18) },
      '.cm-panels': { backgroundColor: C.panel, color: C.text },
      '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${ink(0.1)}` },
      '.cm-searchMatch': {
        backgroundColor: accentA(0.24),
        outline: `1px solid ${C.accentBorder}`,
      },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: accentA(0.42) },
      '.cm-textfield': {
        backgroundColor: C.input,
        color: C.textHi,
        border: `1px solid ${C.border3}`,
      },
      '.cm-button': { backgroundColor: C.input, color: C.text, border: `1px solid ${C.border3}` },
    },
    { dark },
  )
}

// Token colours come from the active theme's `syntax` palette (shared/themes.ts),
// published as --c-syn-* by applyTheme(). The set of tags is unchanged from the
// inlined one-dark mapping this replaced; only the source of the colours moved.
const S = {
  keyword: 'var(--c-syn-keyword)',
  name: 'var(--c-syn-name)',
  func: 'var(--c-syn-func)',
  constant: 'var(--c-syn-constant)',
  def: 'var(--c-syn-def)',
  type: 'var(--c-syn-type)',
  operator: 'var(--c-syn-operator)',
  comment: 'var(--c-syn-comment)',
  string: 'var(--c-syn-string)',
  invalid: 'var(--c-syn-invalid)',
}

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: S.keyword },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: S.name },
  { tag: [t.function(t.variableName), t.labelName], color: S.func },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: S.constant },
  { tag: [t.definition(t.name), t.separator], color: S.def },
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
    color: S.type,
  },
  {
    tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)],
    color: S.operator,
  },
  { tag: [t.meta, t.comment], color: S.comment },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: S.comment, textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: S.name },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: S.constant },
  { tag: [t.processingInstruction, t.string, t.inserted], color: S.string },
  { tag: t.invalid, color: S.invalid },
])

export function editorTheme(dark: boolean): Extension {
  return [chrome(dark), syntaxHighlighting(highlight)]
}
