import type { CustomTheme } from '../shared/themes'
import { useStore } from './state/store'
import { applyThemeFromSettings } from './theme-apply'

/**
 * Write the whole theme set and take back what the main process makes of it.
 *
 * Two things come back rather than one: the sanitised list, and the settings —
 * because deleting the theme you were using has to move the selection too, and
 * that repair happens on the main side where the file that the next launch reads
 * actually lives.
 *
 * The repaint is explicit. App's theme effect keys on the settings' `theme` id,
 * so editing a theme's *colours* without changing which one is selected would
 * otherwise change nothing on screen.
 */
export async function writeThemes(next: CustomTheme[]): Promise<void> {
  const { themes, settings } = await window.terminator.saveCustomThemes(next)
  const store = useStore.getState()
  store.setCustomThemes(themes)
  store.setSettings(settings)
  applyThemeFromSettings(settings)
}

/** "Nord copy", then "Nord copy 2" — a duplicate never silently reuses a name. */
export function freeName(base: string, taken: string[]): string {
  const wanted = `${base} copy`
  if (!taken.includes(wanted)) return wanted
  for (let n = 2; n < 500; n++) {
    if (!taken.includes(`${wanted} ${n}`)) return `${wanted} ${n}`
  }
  return wanted
}

/** The set with one theme replaced, or appended when it's new. */
export function upsert(list: CustomTheme[], seed: CustomTheme): CustomTheme[] {
  const at = list.findIndex((t) => t.id === seed.id)
  if (at < 0) return [...list, seed]
  const next = list.slice()
  next[at] = seed
  return next
}
