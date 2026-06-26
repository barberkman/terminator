import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { Channels } from '../shared/channels'
import type { CreateSessionInput, SessionMode } from '../shared/types'
import * as ptyMgr from './pty-manager'
import * as state from './state'
import { startSession, switchMode } from './session-launcher'
import { loadSettings, rememberProject, saveSettings } from './settings'
import { addWorktree, openGitGui, removeWorktree } from './worktree'

/** Registers every ipcMain handler. The single IPC registry for the main process. */
export function registerIpc(getWin: () => BrowserWindow): void {
  ipcMain.handle(Channels.ping, () => 'pong')

  // ---- sessions ----
  ipcMain.handle(Channels.sessionList, () => state.listSessions())
  ipcMain.handle(Channels.sessionCreate, async (_e, input: CreateSessionInput) => {
    const session = state.createSession(input)
    rememberProject(input.projectPath, input.projectName)
    // Create the worktree before returning so the PTY launches in it (any kind).
    if (input.worktree) {
      try {
        const path = await addWorktree(input.projectPath, session.branch)
        state.updateSession(session.id, { worktreePath: path })
      } catch (e) {
        state.updateSession(session.id, {
          status: 'error',
          activity: `worktree failed: ${String(e).slice(0, 80)}`,
        })
      }
    }
    return state.getSession(session.id)
  })
  ipcMain.handle(
    Channels.sessionStart,
    (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
      startSession(getWin(), id, { cols, rows })
    },
  )
  ipcMain.handle(Channels.sessionRemove, (_e, id: string) => state.removeSession(id))
  ipcMain.handle(
    Channels.sessionRename,
    (_e, { id, name }: { id: string; name: string }) => {
      state.updateSession(id, { name })
    },
  )
  ipcMain.handle(
    Channels.sessionSetMode,
    (_e, { id, mode }: { id: string; mode: SessionMode }) => {
      switchMode(getWin(), id, mode)
    },
  )
  ipcMain.handle(Channels.sessionOpenGitGui, (_e, id: string) => openGitGui(id))
  ipcMain.handle(Channels.worktreeRemove, (_e, id: string) => removeWorktree(id))
  ipcMain.on(Channels.sessionClearNotified, (_e, id: string) => state.clearNotified(id))

  // ---- pty hot path ----
  ipcMain.on(Channels.ptyWrite, (_e, { id, data }: { id: string; data: string }) =>
    ptyMgr.writePty(id, data),
  )
  ipcMain.on(
    Channels.ptyResize,
    (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) =>
      ptyMgr.resizePty(id, cols, rows),
  )

  // ---- dialogs / settings ----
  ipcMain.handle(Channels.pickFolder, async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle(Channels.settingsGet, () => loadSettings())
  ipcMain.handle(Channels.settingsUpdate, (_e, patch) => saveSettings(patch))
}
