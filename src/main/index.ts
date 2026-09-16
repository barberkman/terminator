import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { pruneAttachments } from './attachments'
import { applyWebviewPolicy, configureBrowserSession } from './browser'
import { openLink } from './links'
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
      // Browser panes are <webview> elements. See browser.ts for why a DOM element
      // rather than a WebContentsView, and for the guards that make this safe: the
      // tag only lets the renderer *ask* for an embedded page — what that page is
      // allowed to be is decided below and in browser.ts, never by the renderer.
      webviewTag: true,
    },
  })

  // The renderer writes the <webview> attributes, so main gets the last word on
  // them — the same posture links.ts takes towards a URL it was handed. That is what
  // makes `webviewTag: true` above affordable: the tag lets the renderer *ask* for a
  // guest, it doesn't let it define one. The policy itself lives in browser.ts, with
  // the rest of what a guest is allowed to be.
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    if (!applyWebviewPolicy(prefs, params)) event.preventDefault()
  })

  // Nothing opens a window off the app's own renderer. Electron's default for an
  // unhandled window.open is a BrowserWindow that inherits this window's
  // webPreferences — preload included — so a `target="_blank"` in a transcript
  // could put an arbitrary page in a window holding `window.terminator`. A link
  // leaves by the same door as every other link instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openLink(url)
    return { action: 'deny' }
  })

  // And the app's own window never navigates off index.html. The drag handlers in
  // App.tsx already swallow stray file drops for this reason; this is the backstop
  // under them, for the routes they don't see.
  win.webContents.on('will-navigate', (e) => e.preventDefault())

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
  // Before any window exists, so no page can render ahead of its guards.
  configureBrowserSession()
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
