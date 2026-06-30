import { clipboard, contextBridge, ipcRenderer, webFrame } from 'electron'
import { Channels } from '../shared/channels'
import type {
  CreateSessionInput,
  PtyData,
  PtyExit,
  Session,
  SessionMode,
  Settings,
  TerminatorApi,
} from '../shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: TerminatorApi = {
  ping: () => ipcRenderer.invoke(Channels.ping),

  listSessions: () => ipcRenderer.invoke(Channels.sessionList),
  createSession: (input: CreateSessionInput) => ipcRenderer.invoke(Channels.sessionCreate, input),
  startSession: (id, cols, rows) => ipcRenderer.invoke(Channels.sessionStart, { id, cols, rows }),
  removeSession: (id) => ipcRenderer.invoke(Channels.sessionRemove, id),
  renameSession: (id, name) => ipcRenderer.invoke(Channels.sessionRename, { id, name }),
  setMode: (id, mode: SessionMode) => ipcRenderer.invoke(Channels.sessionSetMode, { id, mode }),
  runTaskCommand: (id, task) => ipcRenderer.invoke(Channels.runTaskCommand, { id, task }),
  openGitGui: (id) => ipcRenderer.invoke(Channels.sessionOpenGitGui, id),
  removeWorktree: (id) => ipcRenderer.invoke(Channels.worktreeRemove, id),
  clearNotified: (id) => ipcRenderer.send(Channels.sessionClearNotified, id),
  reorderSessions: (ids) => ipcRenderer.send(Channels.sessionReorder, ids),

  writePty: (id, data) => ipcRenderer.send(Channels.ptyWrite, { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send(Channels.ptyResize, { id, cols, rows }),
  onPtyData: (cb: (p: PtyData) => void) => on(Channels.ptyData, cb),
  onPtyExit: (cb: (p: PtyExit) => void) => on(Channels.ptyExit, cb),
  onPtyReset: (cb: (id: string) => void) => on(Channels.ptyReset, cb),

  onSessionUpdated: (cb: (s: Session) => void) => on(Channels.sessionUpdated, cb),
  onSessionRemoved: (cb: (id: string) => void) => on(Channels.sessionRemoved, cb),
  onNavJump: (cb: (id: string) => void) => on(Channels.navJump, cb),

  pickFolder: () => ipcRenderer.invoke(Channels.pickFolder),
  getSettings: () => ipcRenderer.invoke(Channels.settingsGet),
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(Channels.settingsUpdate, patch),
  getGlobalShortcutStatus: () => ipcRenderer.invoke(Channels.globalShortcutStatus),

  setZoom: (factor: number) => webFrame.setZoomFactor(factor),
  getZoom: () => webFrame.getZoomFactor(),

  clipboardWrite: (text: string) => clipboard.writeText(text),
  clipboardRead: () => clipboard.readText(),
}

contextBridge.exposeInMainWorld('terminator', api)
