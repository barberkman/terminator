import { globalShortcut, type BrowserWindow } from 'electron'
import { loadSettings } from './settings'

// Yakuake-style global show/hide hotkey: a system-wide shortcut that summons or
// dismisses the window, with a short opacity fade. Registration is driven by the
// `globalToggleShortcut` setting and refreshed whenever settings change.

const FADE_MS = 150
let fadeTimer: NodeJS.Timeout | null = null
/** The accelerator currently registered with the OS (so we can unregister on change). */
let registered = ''

/** Opacity tween (easeOutQuad). No-op-safe: setOpacity needs a compositor; without
 *  one it's effectively instant and the toggle still works. */
function fade(win: BrowserWindow, from: number, to: number, done?: () => void): void {
  if (fadeTimer) {
    clearInterval(fadeTimer)
    fadeTimer = null
  }
  const steps = Math.max(1, Math.round(FADE_MS / 16))
  let i = 0
  win.setOpacity(from)
  fadeTimer = setInterval(() => {
    if (win.isDestroyed()) {
      if (fadeTimer) clearInterval(fadeTimer)
      fadeTimer = null
      return
    }
    i++
    const t = i / steps
    const eased = 1 - (1 - t) * (1 - t)
    win.setOpacity(from + (to - from) * eased)
    if (i >= steps) {
      if (fadeTimer) clearInterval(fadeTimer)
      fadeTimer = null
      win.setOpacity(to)
      done?.()
    }
  }, 16)
}

/** Summon / dismiss: restore+focus if minimized, raise if visible-but-behind, else minimize. */
export function toggleWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) {
    win.setOpacity(0)
    win.restore()
    win.focus()
    fade(win, 0, 1)
  } else if (!win.isFocused()) {
    win.show()
    win.focus()
  } else {
    fade(win, 1, 0, () => {
      win.minimize()
      // Reset so a later taskbar restore (not via the hotkey) isn't transparent.
      win.setOpacity(1)
    })
  }
}

/** (Re)register the global hotkey from the current settings. Returns whether it took. */
export function applyGlobalShortcut(getWin: () => BrowserWindow | null): boolean {
  if (registered) {
    globalShortcut.unregister(registered)
    registered = ''
  }
  const accel = (loadSettings().globalToggleShortcut || '').trim()
  if (!accel) return false
  try {
    const ok = globalShortcut.register(accel, () => toggleWindow(getWin()))
    if (ok) registered = accel
    return ok
  } catch {
    // Invalid accelerator string — treat as not registered.
    return false
  }
}

export function globalShortcutStatus(): { accelerator: string; registered: boolean } {
  const accel = (loadSettings().globalToggleShortcut || '').trim()
  return { accelerator: accel, registered: !!accel && globalShortcut.isRegistered(accel) }
}

export function disposeGlobalShortcut(): void {
  globalShortcut.unregisterAll()
  registered = ''
}
