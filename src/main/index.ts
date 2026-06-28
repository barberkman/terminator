import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { registerIpc } from './ipc'
import { killAll } from './pty-manager'
import { loadPersisted, setWindow, wireProcessEvents } from './state'
import { startReportServer, stopReportServer } from './report-server'
import { applyGlobalShortcut, disposeGlobalShortcut } from './window-toggle'

let win: BrowserWindow | null = null

function createWindow(): void {
  // Packaged: copied next to the app via electron-builder extraResources.
  // Dev: __dirname is out/main, so ../../build/icon.png is the repo asset.
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png')

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#1a1917',
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
}

app.whenReady().then(async () => {
  await startReportServer()
  loadPersisted()
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
  stopReportServer()
  disposeGlobalShortcut()
})
