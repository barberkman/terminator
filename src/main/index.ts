import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { pruneAttachments } from './attachments'
import { registerIpc } from './ipc'
import { killAll } from './pty-manager'
import { closeAll as closeFsWatchers, setWindow as setFsWindow } from './fs-service'
import { loadPersisted, setWindow, wireProcessEvents } from './state'
import { startReportServer, stopReportServer } from './report-server'
import { applyGlobalShortcut, disposeGlobalShortcut } from './window-toggle'
import { loadSettings } from './settings'
import { resolveTheme, setCustomThemes } from '../shared/themes'
import { loadCustomThemes } from './theme-store'
import { flushUsage, setWindow as setUsageWindow } from './usage-store'

let win: BrowserWindow | null = null

function createWindow(): void {
  // Packaged: copied next to the app via electron-builder extraResources.
  // Dev: __dirname is out/main, so ../../build/icon.png is the repo asset.
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png')

  const settings = loadSettings()
  // Publish the user's own themes before resolving, so a window on a custom theme
  // still opens on its real background rather than falling back to the default.
  setCustomThemes(loadCustomThemes())
  const theme = resolveTheme(settings.theme, settings.customTheme)

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    // The window paints this before the renderer's first frame, so it has to be
    // the chosen theme's background — otherwise a light theme opens with a dark flash.
    backgroundColor: theme.bg,
    title: 'Terminator',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  setWindow(win)
  setFsWindow(win)
  setUsageWindow(win)
}

app.whenReady().then(async () => {
  await startReportServer()
  loadPersisted()
  // Pasted images are the only files the app leaves lying around; clear out the
  // stale ones before anything can add more.
  pruneAttachments()
  wireProcessEvents()
  registerIpc(() => win as BrowserWindow)
  createWindow()
  applyGlobalShortcut(() => win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Make sure no shell/claude PTYs are orphaned when the app quits.
app.on('before-quit', () => {
  // Surviving the restart is the whole point of the usage snapshot, so its debounced
  // save gets written out rather than dropped.
  flushUsage()
  killAll()
  closeFsWatchers()
  stopReportServer()
  disposeGlobalShortcut()
})
