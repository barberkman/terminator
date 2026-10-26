import { stat } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { Channels } from '../shared/channels'
import { setCustomThemes } from '../shared/themes'
import type { SettingsChange } from '../shared/types'
import { applyBrowserUserAgent } from './browser'
import { applyScripting } from './control-server'
import { loadSettings, reloadSettings, syncStatus } from './settings'
import { configuredSyncDir, syncFiles } from './sync-files'
import { loadCustomThemes, reloadCustomThemes } from './theme-store'
import { applyGlobalShortcut } from './window-toggle'

// Notices a `git pull` (or any edit) in the sync folder while the app runs, reads
// it, and tells the window. Polling rather than fs.watch: it works on a folder that
// isn't there yet, a network share, and every OS alike, and stat-ing four small
// files once a second costs nothing. Async, so a share that has gone away can't
// hold up the main process.

const POLL_MS = 1000

let timer: ReturnType<typeof setInterval> | null = null
let getWin: () => BrowserWindow | null = () => null
let busy = false
/** The folder's state last tick, and the one last read. */
let seen = ''
let applied = ''
/** What the window was last told. */
let sent = ''

async function fingerprint(dir: string): Promise<string> {
  const f = syncFiles(dir)
  const parts = await Promise.all(
    [f.settings, f.os, f.themes, f.notes].map(async (path) => {
      if (!path) return ''
      try {
        const s = await stat(path)
        return `${s.mtimeMs}:${s.size}:${s.ino}`
      } catch {
        return '-'
      }
    }),
  )
  return `${dir}|${parts.join('|')}`
}

async function tick(): Promise<void> {
  if (busy) return
  busy = true
  try {
    const dir = configuredSyncDir()
    const now = dir ? await fingerprint(dir) : ''
    // A change has to hold still for a tick before it's read: git checks a file out
    // by deleting it and writing it afresh, and a pull touches several files.
    if (now !== seen) {
      seen = now
      return
    }
    if (now === applied) return
    applied = now
    if (!dir) return
    // Settings first: they decide whether the folder is usable, which is where the
    // themes are read from.
    const moved = reloadSettings()
    reloadCustomThemes()
    if (moved) {
      applyGlobalShortcut(getWin)
      applyScripting()
      applyBrowserUserAgent()
    }
    publishSettings()
  } catch {
    // The next tick tries again.
  } finally {
    busy = false
  }
}

function snapshot(): SettingsChange {
  return { settings: loadSettings(), themes: loadCustomThemes(), sync: syncStatus() }
}

/**
 * Tell the window about settings, themes and the folder's state together, so a
 * theme that arrived with the setting selecting it paints at once. Cheap to call
 * after anything that might have moved them: nothing is sent when nothing did.
 */
export function publishSettings(): void {
  const change = snapshot()
  const key = JSON.stringify(change)
  if (key === sent) return
  sent = key
  // Main's own registry, for a window opened later (the Dock re-opens one on macOS).
  setCustomThemes(change.themes)
  const win = getWin()
  if (win && !win.isDestroyed()) win.webContents.send(Channels.settingsChanged, change)
}

export function startSyncWatch(win: () => BrowserWindow | null): void {
  getWin = win
  // What the window reads for itself as it loads.
  sent = JSON.stringify(snapshot())
  timer ??= setInterval(() => void tick(), POLL_MS)
}

export function stopSyncWatch(): void {
  if (timer) clearInterval(timer)
  timer = null
}
