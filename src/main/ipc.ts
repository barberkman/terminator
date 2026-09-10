import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { Channels } from '../shared/channels'
import { DEFAULT_THEME_ID, isBuiltIn } from '../shared/themes'
import type {
  AttachFileInput,
  BranchResult,
  BranchSessionInput,
  ConversationSlice,
  CreateSessionInput,
  FolderChoice,
  OpenFileInput,
  SessionMode,
  TaskCommand,
  TranscriptPrompt,
} from '../shared/types'
import { attachClipboardImage, attachFiles } from './attachments'
import { openInEditor, openLink, resolveOutputPath } from './links'
import * as ptyMgr from './pty-manager'
import * as fsService from './fs-service'
import * as state from './state'
import {
  relaunchSession,
  runTaskCommand,
  startSession,
  stopSession,
  switchMode,
} from './session-launcher'
import { loadSettings, rememberProject, saveSettings } from './settings'
import { loadCustomThemes, saveCustomThemes } from './theme-store'
import { loadUsage } from './usage-store'
import { addWorktree, openGitGui, openInFolder, removeWorktree } from './worktree'
import { forkTranscript, listPrompts } from './transcript'
import { readConversation } from './conversation'
import { setPendingPrompt } from './prefill'
import { applyGlobalShortcut, globalShortcutStatus } from './window-toggle'

/** Registers every ipcMain handler. The single IPC registry for the main process. */
export function registerIpc(getWin: () => BrowserWindow): void {
  ipcMain.handle(Channels.ping, () => 'pong')

  // ---- sessions ----
  ipcMain.handle(Channels.sessionList, () => state.listSessions())
  ipcMain.handle(Channels.sessionCreate, async (_e, input: CreateSessionInput) => {
    const session = state.createSession(input)
    // A Build/Run terminal reuses its project's path; that project is already in
    // recents from its first non-task session, so only remember on real sessions.
    // A session started *in* someone's worktree is the same story: the worktree
    // is that session's folder, not a project of its own, so keep it out of recents.
    const inKnownWorktree = state
      .listSessions()
      .some((x) => !!x.worktreePath && x.worktreePath === session.projectPath)
    if (!input.task && !inKnownWorktree) rememberProject(input.projectPath, input.projectName)
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
    (_e, { id, cols, rows }: { id: string; cols?: number; rows?: number }) => {
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
  ipcMain.handle(Channels.sessionStop, (_e, id: string) => stopSession(id))
  ipcMain.handle(Channels.sessionRelaunch, (_e, id: string) => relaunchSession(getWin(), id))
  ipcMain.handle(
    Channels.runTaskCommand,
    (_e, { id, task }: { id: string; task: TaskCommand }) =>
      runTaskCommand(getWin(), id, task),
  )
  // `which` names one of the session's two folders; the path itself is still
  // resolved main-side from the session id.
  ipcMain.handle(
    Channels.sessionOpenGitGui,
    (_e, { id, which }: { id: string; which?: FolderChoice }) => openGitGui(id, which),
  )
  ipcMain.handle(
    Channels.sessionOpenInFolder,
    (_e, { id, which }: { id: string; which?: FolderChoice }) => openInFolder(id, which),
  )
  ipcMain.handle(Channels.worktreeRemove, (_e, id: string) => removeWorktree(id))
  ipcMain.on(Channels.sessionClearNotified, (_e, id: string) => state.clearNotified(id))
  ipcMain.on(Channels.sessionReorder, (_e, ids: string[]) => state.reorderSessions(ids))

  // ---- conversation branching ----
  ipcMain.handle(Channels.sessionListPrompts, (_e, id: string): TranscriptPrompt[] => {
    const s = state.getSession(id)
    if (!s || s.kind !== 'claude') return []
    return listPrompts(s.id, s.worktreePath || s.projectPath)
  })

  // ---- conversation view ----
  // Same transcript, read as a document. The cwd is resolved here from the
  // session id, like every other path in this file — never taken from the renderer.
  ipcMain.handle(
    Channels.sessionConversation,
    (_e, { id, from }: { id: string; from: number }): ConversationSlice => {
      const s = state.getSession(id)
      const empty = { items: [], outputs: {}, nextOffset: 0, reset: false, exists: false }
      if (!s || s.kind !== 'claude') return empty
      return readConversation(s.id, s.worktreePath || s.projectPath, Math.max(0, from | 0))
    },
  )
  ipcMain.handle(
    Channels.sessionBranch,
    async (_e, input: BranchSessionInput): Promise<BranchResult> => {
      const parent = state.getSession(input.parentId)
      if (!parent || parent.kind !== 'claude') {
        return { ok: false, reason: 'only a Claude session has a conversation to branch' }
      }
      const parentCwd = parent.worktreePath || parent.projectPath
      const branchName = input.branch?.trim() || `${parent.name}-branch`

      // The worktree comes first: Claude keys a transcript's location by the
      // working directory, so the branch's cwd has to be settled before the fork.
      let worktreePath: string | undefined
      if (input.worktree) {
        try {
          worktreePath = await addWorktree(parent.projectPath, branchName)
        } catch (e) {
          return { ok: false, reason: `worktree failed: ${String(e).slice(0, 120)}` }
        }
      }

      const session = state.createSession(
        {
          kind: 'claude',
          mode: parent.mode,
          name: input.name?.trim() || `${parent.name} ⑂`,
          projectPath: parent.projectPath,
          projectName: parent.projectName,
        },
        { parentId: parent.id, branchedFrom: parent.name, branchPoint: input.keptPrompts },
      )
      state.updateSession(session.id, {
        worktreePath,
        branch: worktreePath ? branchName : parent.branch,
      })

      // Cutting above the first prompt means "same project, blank slate": there is
      // no history to carry, so leave the transcript unseeded and let the launcher
      // start it with --session-id like any new session.
      const forked =
        input.keptPrompts > 0
          ? forkTranscript({
              parentSessionId: parent.id,
              parentCwd,
              newSessionId: session.id,
              newCwd: worktreePath || parent.projectPath,
              cutBeforeUuid: input.cutBeforeUuid,
            })
          : ({ ok: true } as const)
      if (!forked.ok) {
        // Leave nothing behind: the session never ran, and its worktree would be
        // orphaned once the session row is gone.
        if (worktreePath) await removeWorktree(session.id).catch(() => {})
        state.removeSession(session.id)
        return forked
      }
      if (input.prefill) setPendingPrompt(session.id, input.prefill)
      return { ok: true, session: state.getSession(session.id)! }
    },
  )

  // ---- pty hot path ----
  ipcMain.on(Channels.ptyWrite, (_e, { id, data }: { id: string; data: string }) =>
    ptyMgr.writePty(id, data),
  )
  ipcMain.on(
    Channels.ptyResize,
    (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) =>
      ptyMgr.resizePty(id, cols, rows),
  )

  // ---- attachments (paste / drag-and-drop) ----
  ipcMain.handle(Channels.attachClipboard, (_e, id: string) => attachClipboardImage(id))
  ipcMain.handle(
    Channels.attachFiles,
    (_e, { id, files }: { id: string; files: AttachFileInput[] }) => attachFiles(id, files),
  )

  // ---- links (clickable URLs / paths in terminal output) ----
  // The URL is re-validated inside openLink: what the renderer saw on screen is
  // a suggestion, not permission to launch anything.
  ipcMain.handle(
    Channels.linkOpen,
    (_e, { url, browserId }: { url: string; browserId?: string }) => openLink(url, browserId),
  )
  ipcMain.handle(
    Channels.linkResolvePath,
    (_e, { sessionId, token }: { sessionId: string; token: string }) =>
      resolveOutputPath(sessionId, token),
  )
  // Same posture as linkOpen: the path is re-resolved against the session's own
  // folder inside openInEditor before anything is launched.
  ipcMain.handle(Channels.linkOpenFile, (_e, input: OpenFileInput) => openInEditor(input))

  // ---- filesystem (editor sessions) ----
  // Root is resolved here from the session id — never trusted from the renderer.
  const editorRoot = (sessionId: string): string | null => {
    const s = state.getSession(sessionId)
    return s ? s.worktreePath || s.projectPath : null
  }
  ipcMain.handle(Channels.fsList, (_e, { sessionId, dir }: { sessionId: string; dir: string }) => {
    const root = editorRoot(sessionId)
    return root ? fsService.listDir(root, dir) : []
  })
  ipcMain.handle(
    Channels.fsRead,
    (_e, { sessionId, path }: { sessionId: string; path: string }) => {
      const root = editorRoot(sessionId)
      return root ? fsService.readFile(root, path) : { ok: false as const, reason: 'missing' as const }
    },
  )
  ipcMain.handle(
    Channels.fsWrite,
    (_e, { sessionId, path, content }: { sessionId: string; path: string; content: string }) => {
      const root = editorRoot(sessionId)
      if (!root) throw new Error('unknown session')
      return fsService.writeFile(root, path, content)
    },
  )
  ipcMain.on(Channels.fsWatch, (_e, { sessionId, path }: { sessionId: string; path: string }) => {
    const root = editorRoot(sessionId)
    if (root) fsService.watchPath(sessionId, root, path)
  })
  ipcMain.on(Channels.fsUnwatch, (_e, { sessionId, path }: { sessionId: string; path: string }) => {
    const root = editorRoot(sessionId)
    if (root) fsService.unwatchPath(sessionId, root, path)
  })

  // ---- dialogs / settings ----
  ipcMain.handle(Channels.pickFolder, async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle(Channels.pickFile, async (_e, title?: string) => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: title || 'Choose a program',
      properties: ['openFile'],
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle(Channels.settingsGet, () => loadSettings())
  ipcMain.handle(Channels.settingsUpdate, (_e, patch) => {
    const next = saveSettings(patch)
    // Re-register the global hotkey in case it changed.
    applyGlobalShortcut(getWin)
    return next
  })
  ipcMain.handle(Channels.themesGet, () => loadCustomThemes())
  ipcMain.handle(Channels.themesSave, (_e, list: unknown) => {
    const themes = saveCustomThemes(list)
    // A theme can only disappear through this call, so this is where a dangling
    // selection gets repaired. The renderer falls back at paint time anyway, but
    // the window's backgroundColor is read from settings at launch — so the file
    // has to agree, or the next start opens on the wrong ground.
    const current = loadSettings().theme
    const settings =
      isBuiltIn(current) || themes.some((t) => t.id === current)
        ? loadSettings()
        : saveSettings({ theme: DEFAULT_THEME_ID })
    return { themes, settings }
  })
  ipcMain.handle(Channels.globalShortcutStatus, () => globalShortcutStatus())

  // ---- account-wide rate-limit usage ----
  // Read-only from here: the values are written by the statusLine reports arriving at
  // report-server.ts, and pushed out on Channels.usageUpdated.
  ipcMain.handle(Channels.usageGet, () => loadUsage())
}
