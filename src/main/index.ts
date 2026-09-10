import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { pruneAttachments } from './attachments'
import { registerIpc } from './ipc'
import { killAll } from './pty-manager'
import { closeAll as closeFsWatchers, setWindow as setFsWindow } from './fs-service'
import { loadPersisted, setWindow, wireProcessEvents } from './state'
import { startReportServer, stopReportServer } from './report-server'
import { applyGlobalShortcut, disposeGlobalShortcut, setFadeEnabled } from './window-toggle'
import { loadSettings } from './settings'
import { cssVars, resolveTheme, setCustomThemes } from '../shared/themes'
import { loadCustomThemes } from './theme-store'
import { glassWindowOptions, resolveGlass, setActiveGlass } from './glass'

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

  const glass = resolveGlass(settings.windowGlass)
  setActiveGlass(glass)

  // Note for anyone extending this: setIgnoreMouseEvents is deliberately never
  // called. A see-through area is still a normal part of the window — it takes
  // clicks and it takes focus — and the opacity floors in shared/themes.ts keep
  // every surface above zero alpha so there's never a hole to fall through.

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    // With glass off this is `backgroundColor: theme.bg` and nothing else: the
    // window paints the chosen theme's background before the renderer's first
    // frame, so a light theme never opens with a dark flash. A glass mode has to
    // clear that to nothing for the desktop to reach the client area, and pays
    // the difference back with the boot palette below — the renderer's own first
    // paint then needs no IPC round-trip.
    ...glassWindowOptions(glass.active, theme),
    title: 'Terminator',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Preload runs before the document, so this reaches the first paint with
      // no round-trip. main.tsx writes it straight onto the root element.
      additionalArguments: [
        `--terminator-boot=${Buffer.from(
          JSON.stringify({ vars: cssVars(theme), dark: theme.dark, id: theme.id, glass: glass.active }),
        ).toString('base64')}`,
      ],
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  setFadeEnabled(glass.active === 'off')
  setWindow(win)
  setFsWindow(win)
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
  killAll()
  closeFsWatchers()
  stopReportServer()
  disposeGlobalShortcut()
})
