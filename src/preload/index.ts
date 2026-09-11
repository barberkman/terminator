import { clipboard, contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import { Channels } from '../shared/channels'
import type { CustomTheme } from '../shared/themes'
import type {
  AttachFileInput,
  BranchSessionInput,
  CreateSessionInput,
  FolderChoice,
  FsChange,
  OpenFileInput,
  PtyData,
  PtyExit,
  Session,
  SessionMode,
  Settings,
  TerminatorApi,
  UsageSnapshot,
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
  stopSession: (id) => ipcRenderer.invoke(Channels.sessionStop, id),
  relaunchSession: (id) => ipcRenderer.invoke(Channels.sessionRelaunch, id),
  runTaskCommand: (id, task) => ipcRenderer.invoke(Channels.runTaskCommand, { id, task }),
  openGitGui: (id, which?: FolderChoice) =>
    ipcRenderer.invoke(Channels.sessionOpenGitGui, { id, which }),
  openInFolder: (id, which?: FolderChoice) =>
    ipcRenderer.invoke(Channels.sessionOpenInFolder, { id, which }),
  removeWorktree: (id) => ipcRenderer.invoke(Channels.worktreeRemove, id),
  clearNotified: (id) => ipcRenderer.send(Channels.sessionClearNotified, id),
  reorderSessions: (ids) => ipcRenderer.send(Channels.sessionReorder, ids),
  listPrompts: (id) => ipcRenderer.invoke(Channels.sessionListPrompts, id),
  branchSession: (input: BranchSessionInput) => ipcRenderer.invoke(Channels.sessionBranch, input),
  readConversation: (id, from) => ipcRenderer.invoke(Channels.sessionConversation, { id, from }),
  sendPrompt: (id, text) => ipcRenderer.invoke(Channels.sessionSendPrompt, { id, text }),

  writePty: (id, data) => ipcRenderer.send(Channels.ptyWrite, { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send(Channels.ptyResize, { id, cols, rows }),
  onPtyData: (cb: (p: PtyData) => void) => on(Channels.ptyData, cb),
  onPtyExit: (cb: (p: PtyExit) => void) => on(Channels.ptyExit, cb),
  onPtyReset: (cb: (id: string) => void) => on(Channels.ptyReset, cb),

  onSessionUpdated: (cb: (s: Session) => void) => on(Channels.sessionUpdated, cb),
  onSessionRemoved: (cb: (id: string) => void) => on(Channels.sessionRemoved, cb),
  onNavJump: (cb: (id: string) => void) => on(Channels.navJump, cb),

  fsList: (sessionId, dir) => ipcRenderer.invoke(Channels.fsList, { sessionId, dir }),
  fsRead: (sessionId, path) => ipcRenderer.invoke(Channels.fsRead, { sessionId, path }),
  fsWrite: (sessionId, path, content) =>
    ipcRenderer.invoke(Channels.fsWrite, { sessionId, path, content }),
  fsWatch: (sessionId, path) => ipcRenderer.send(Channels.fsWatch, { sessionId, path }),
  fsUnwatch: (sessionId, path) => ipcRenderer.send(Channels.fsUnwatch, { sessionId, path }),
  onFsChanged: (cb: (c: FsChange) => void) => on(Channels.fsChanged, cb),

  pickFolder: () => ipcRenderer.invoke(Channels.pickFolder),
  pickFile: (title?: string) => ipcRenderer.invoke(Channels.pickFile, title),
  getSettings: () => ipcRenderer.invoke(Channels.settingsGet),
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(Channels.settingsUpdate, patch),
  getGlobalShortcutStatus: () => ipcRenderer.invoke(Channels.globalShortcutStatus),
  getCustomThemes: () => ipcRenderer.invoke(Channels.themesGet),
  saveCustomThemes: (list: CustomTheme[]) => ipcRenderer.invoke(Channels.themesSave, list),

  getUsage: () => ipcRenderer.invoke(Channels.usageGet),
  onUsageUpdated: (cb: (u: UsageSnapshot) => void) => on(Channels.usageUpdated, cb),

  setZoom: (factor: number) => webFrame.setZoomFactor(factor),
  getZoom: () => webFrame.getZoomFactor(),

  clipboardWrite: (text: string) => clipboard.writeText(text),
  clipboardRead: () => clipboard.readText(),
  // Synchronous on purpose: the Ctrl/Cmd+V handler has to decide between an image
  // attachment and the plain text paste before it returns.
  clipboardHasImage: () => !clipboard.readImage().isEmpty(),

  openLink: (url: string, browserId?: string) =>
    ipcRenderer.invoke(Channels.linkOpen, { url, browserId }),
  resolveOutputPath: (sessionId: string, token: string) =>
    ipcRenderer.invoke(Channels.linkResolvePath, { sessionId, token }),
  openFileInEditor: (input: OpenFileInput) => ipcRenderer.invoke(Channels.linkOpenFile, input),

  attachClipboardImage: (id: string) => ipcRenderer.invoke(Channels.attachClipboard, id),
  attachFiles: (id: string, files: AttachFileInput[]) =>
    ipcRenderer.invoke(Channels.attachFiles, { id, files }),
  openAttachment: (path: string) => ipcRenderer.invoke(Channels.attachOpen, path),
  revealAttachment: (path: string) => ipcRenderer.invoke(Channels.attachReveal, path),
  // Electron 32 removed File.path; this is the supported replacement. Returns ''
  // for anything that isn't a real file on disk (e.g. dragged out of a browser).
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  // No IPC: the platform never changes under a running window, and the renderer
  // only needs it to name the file manager (Explorer / Finder) correctly.
  platform: process.platform,
}

contextBridge.exposeInMainWorld('terminator', api)
