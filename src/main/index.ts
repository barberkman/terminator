import { join } from 'node:path'
import { app, BrowserWindow, Menu } from 'electron'
import { pruneAttachments } from './attachments'
import { applyWebviewPolicy, configureBrowserSession } from './browser'
import { openLink } from './links'
import { registerIpc } from './ipc'
import { killAll } from './pty-manager'
import { closeAll as closeFsWatchers, setWindow as setFsWindow } from './fs-service'
import {
  disposePromptEditor,
  finishAllEdits,
  setWindow as setPromptEditWindow,
} from './prompt-edit'
import { loadPersisted, setWindow, wireProcessEvents } from './state'
import { reapAllOnQuit, wireLauncher } from './session-launcher'
import { startReportServer, stopReportServer } from './report-server'
import { applyGlobalShortcut, disposeGlobalShortcut } from './window-toggle'
import { loadSettings } from './settings'
import { resolveTheme, setCustomThemes } from '../shared/themes'
import { TITLE_BAR_HEIGHT } from '../shared/types'
import { loadCustomThemes } from './theme-store'
import { flushUsage, setWindow as setUsageWindow } from './usage-store'
import { installCommand } from './cli-install'
import { wireClaudeTurns } from './claude-turns'
import { applyScripting, stopControlServer } from './control-server'
import { startSyncWatch, stopSyncWatch } from './sync-watch'
import { setScriptingWindow, wireScripting } from './scripting'
import { startShellEnv } from './shell-env'
import { macMenu } from './mac-menu'

// macOS: read the login shell's PATH in the background while the app starts up.
startShellEnv()

let win: BrowserWindow | null = null
/** Set as quitting begins, so the window's close goes ahead instead of hiding it (macOS). */
let quitting = false

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
    // Windows paints its own frame in its own colours, which no theme can reach, so
    // the app draws the title bar itself (TitleBar.tsx) and keeps only the native
    // caption buttons, recoloured to match. The renderer repaints them on every
    // theme change; this is just the first frame. macOS gets the same strip, with
    // the traffic lights inset into it — they wear the system's colours, not the
    // theme's, as they do in every Mac app. Linux keeps its frame.
    ...(process.platform === 'win32' && {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: theme.sidebar, symbolColor: theme.text, height: TITLE_BAR_HEIGHT },
    }),
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hidden' as const,
      // Centred in the strip: the buttons are 14 DIPs tall.
      trafficLightPosition: { x: 13, y: Math.round((TITLE_BAR_HEIGHT - 14) / 2) },
    }),
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
  setPromptEditWindow(win)
  setScriptingWindow(win)
  // On macOS closing the window hides it. The sessions are still running, and
  // their terminals and scrollback live in this window's page, so it has to
  // survive to show them again: the Dock icon brings it back (`activate` below).
  // Quitting is the only way it really closes.
  if (process.platform === 'darwin') {
    const w = win
    w.on('close', (e) => {
      if (quitting) return
      e.preventDefault()
      // Hiding a full-screen window would leave its empty Space behind.
      if (w.isFullScreen()) {
        w.once('leave-full-screen', () => w.hide())
        w.setFullScreen(false)
      } else w.hide()
    })
  }
  // The last word for a Claude session still blocked on a Ctrl+G tab, should the
  // window go without `before-quit` having run.
  win.on('closed', finishAllEdits)
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
  wireLauncher()
  wireClaudeTurns()
  wireScripting()
  // Before any shell session can start: they get its folder on their PATH.
  installCommand()
  registerIpc(() => win as BrowserWindow)
  // No menu bar on Windows and Linux, where a bare Alt is what summons one — and
  // Alt is a session shortcut here (Alt+1..9 switches sessions), so the summoning
  // has to go rather than be folded away: `autoHideMenuBar`, which used to sit in
  // the window options above, only hides the bar until Alt asks for it. Nothing in the
  // default menu was the app's: Chromium handles clipboard, undo and select-all in
  // web content natively on both platforms, and every shortcut the app defines
  // lives in the renderer. macOS keeps a menu, where the bar belongs to the
  // system rather than the window, Alt never opens it, and dropping it would cost
  // Cmd+C/V/Q the standard roles that carry them — but its own (see mac-menu.ts).
  Menu.setApplicationMenu(process.platform === 'darwin' ? macMenu() : null)
  createWindow()
  applyGlobalShortcut(() => win)
  // Settings → SCRIPTING: listen for the `terminator` command only while it's on.
  applyScripting()
  // Settings → SYNC: pick up a `git pull` in the settings folder while running.
  startSyncWatch(() => win)

  app.on('activate', () => {
    if (!win || win.isDestroyed()) {
      createWindow()
      return
    }
    // A click on the Dock icon: bring back the window closing hid.
    if (win.isMinimized()) win.restore()
    win.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Make sure no shell/claude PTYs are orphaned when the app quits.
app.on('before-quit', () => {
  quitting = true
  // Surviving the restart is the whole point of the usage snapshot, so its debounced
  // save gets written out rather than dropped.
  flushUsage()
  killAll()
  // A WSL Claude hears about that only as a hang-up; make sure none outlives the app.
  reapAllOnQuit()
  closeFsWatchers()
  disposePromptEditor()
  stopReportServer()
  stopControlServer()
  stopSyncWatch()
  disposeGlobalShortcut()
})
