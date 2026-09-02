import type { Settings } from '../shared/types'
import { type ThemePalette, resolveTheme, cssVars } from '../shared/themes'
import * as terminals from './term/registry'
import * as editors from './editor/registry'

let current: ThemePalette | null = null

/** The palette currently painted. Used by anything that needs literal colours. */
export function activePalette(): ThemePalette | null {
  return current
}

/**
 * Paint a palette: write every token as a CSS custom property on the document
 * root (which is all the app chrome needs — see the `C` tokens in theme.ts),
 * then hand the literal colours to the two surfaces that can't read a `var()`:
 * xterm, which parses colours in JS for its renderer, and CodeMirror, whose
 * `dark` flag is baked into the theme extension at construction.
 */
export function applyTheme(palette: ThemePalette): void {
  current = palette
  const root = document.documentElement
  for (const [name, value] of Object.entries(cssVars(palette))) root.style.setProperty(name, value)
  // Drives the UA's own colours for form controls, scrollbars and canvas.
  root.style.colorScheme = palette.dark ? 'dark' : 'light'
  root.dataset.theme = palette.id
  terminals.setTheme(palette)
  editors.setTheme(palette)
}

/** Resolve and paint the theme a settings object asks for. */
export function applyThemeFromSettings(settings: Pick<Settings, 'theme' | 'customTheme'>): void {
  applyTheme(resolveTheme(settings.theme, settings.customTheme))
}
