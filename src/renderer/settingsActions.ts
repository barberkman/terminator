import type { SettingsPatch } from '../shared/settings-sync'
import type { Settings } from '../shared/types'
import { useStore } from './state/store'
import { applyThemeFromSettings } from './theme-apply'

/** What a rejected IPC call says, without Electron's "Error invoking remote method…" wrapper. */
export function reasonOf(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

/**
 * Save through main and take back what it made of it. A refusal — a synced file
 * with a merge conflict in it, a sync folder that isn't there — becomes a toast
 * saying why, and null, so the caller can keep its draft rather than close on a
 * save that didn't happen.
 */
export async function saveSettings(patch: SettingsPatch): Promise<Settings | null> {
  try {
    const next = await window.terminator.updateSettings(patch)
    useStore.getState().setSettings(next)
    return next
  } catch (e) {
    useStore.getState().pushToast({ tone: 'error', icon: 'settings', text: "Settings weren't saved", sub: reasonOf(e) })
    return null
  }
}

/**
 * Follow settings that change under the window: a `git pull` in the sync folder, or
 * main saving something itself. Themes go in before the settings that may select
 * one of them, and the repaint is explicit, because a pulled edit to the colours of
 * the theme in use changes no id for App's theme effect to see. Not while the theme
 * editor is up: it is painting its own live draft, which the next autosave keeps.
 */
export function listenForSettings(): () => void {
  return window.terminator.onSettingsChanged(({ settings, themes, sync }) => {
    const store = useStore.getState()
    const had = store.syncStatus?.problem
    store.setCustomThemes(themes)
    store.setSettings(settings)
    store.setSyncStatus(sync)
    if (!store.themeEditorFor) applyThemeFromSettings(settings)
    if (sync.problem && sync.problem !== had) {
      store.pushToast({ tone: 'error', icon: 'settings', text: 'Settings sync', sub: sync.problem })
    }
  })
}
