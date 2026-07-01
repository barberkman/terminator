import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import { C, FONT } from '../theme'
import { warmHighlight } from './highlight'

// Chrome (background, gutter, cursor, selection) mapped to the app's warm-dark
// tokens; token colors reuse one-dark's highlight style so we don't hand-roll a
// full syntax palette. `selection` uses the same value the xterm panes use.
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

export const editorTheme: Extension = [chrome, syntaxHighlighting(warmHighlight)]
