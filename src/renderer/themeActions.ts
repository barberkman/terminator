import type { CustomTheme } from '../shared/themes'
import type { ThemeOp } from '../shared/types'
import { reasonOf } from './settingsActions'
import { useStore } from './state/store'
import { applyThemeFromSettings } from './theme-apply'

/**
 * Hand main one change to the theme set and take back what it makes of it. One
 * theme rather than the whole list, because main applies it to the file as it is
 * now — and with a synced folder, a pull may have added a theme this window hasn't
 * heard of yet.
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
async function writeTheme(op: ThemeOp): Promise<boolean> {
  const store = useStore.getState()
  try {
    const { themes, settings } = await window.terminator.updateCustomThemes(op)
    store.setCustomThemes(themes)
    store.setSettings(settings)
    applyThemeFromSettings(settings)
    return true
  } catch (e) {
    store.pushToast({ tone: 'error', icon: 'settings', text: "The theme wasn't saved", sub: reasonOf(e) })
    return false
  }
}

/** Add a theme, or replace the one with its id. */
export function saveTheme(seed: CustomTheme): Promise<boolean> {
  return writeTheme({ upsert: seed })
}

export function deleteTheme(id: string): Promise<boolean> {
  return writeTheme({ remove: id })
}

/** "Darcula copy", then "Darcula copy 2" — a duplicate never silently reuses a name. */
export function freeName(base: string, taken: string[]): string {
  const wanted = `${base} copy`
  if (!taken.includes(wanted)) return wanted
  for (let n = 2; n < 500; n++) {
    if (!taken.includes(`${wanted} ${n}`)) return `${wanted} ${n}`
  }
  return wanted
}
