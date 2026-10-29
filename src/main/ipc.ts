import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { Channels } from '../shared/channels'
import { hostFolder, isWsl, sessionFolder } from '../shared/wsl-path'
import { COLOR_RE, DEFAULT_THEME_ID, isBuiltIn } from '../shared/themes'
import type {
  AttachDeliver,
  AttachFileInput,
  BrowserClearWhat,
  BranchResult,
  BranchSessionInput,
  ConversationSlice,
  CreateSessionInput,
  FolderChoice,
  OpenFileInput,
  PickFileOptions,
  SendPromptResult,
  SessionMode,
  TaskCommand,
  TranscriptPrompt,
} from '../shared/types'
import type { BridgeReply } from '../shared/control'
import { attachClipboardImage, attachFiles, openAttachment, revealAttachment } from './attachments'
import { applyBrowserUserAgent, browserCacheSize, clearBrowserData } from './browser'
import { openInEditor, openLink, resolveOutputPath, webUrl } from './links'
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
import { addWorktree, openGitGui, openInFolder, openProjectEditor, removeWorktree } from './worktree'
import { conversationFile, forkTranscript, listPrompts, transcriptDirFor } from './transcript'
import { readConversation } from './conversation'
import { listDistros, normalizeCreateInput, probe } from './wsl'
import { sendPrompt } from './send-prompt'
import { setPendingPrompt } from './prefill'
import { finishEdit, markEditOpen, promptEditorStatus } from './prompt-edit'
import { applyGlobalShortcut, globalShortcutStatus } from './window-toggle'
import { applyScripting } from './control-server'
import { bridgeReply, rendererIsReady } from './scripting'
import { addToPath, scriptingInfo } from './cli-install'
import { userTyped } from './interrupts'

/** Registers every ipcMain handler. The single IPC registry for the main process. */
export function registerIpc(getWin: () => BrowserWindow): void {
  ipcMain.handle(Channels.ping, () => 'pong')

  // ---- sessions ----
  ipcMain.handle(Channels.sessionList, () => state.listSessions())
  ipcMain.handle(Channels.sessionCreate, async (_e, raw: CreateSessionInput) => {
    // A WSL folder is settled before anything exists: the distro picked (a
    // \\wsl.localhost path names its own), the path made Linux, and resolved inside
    // the distro. A Windows request comes back untouched. Throws a readable reason,
    // which the New Session dialog shows.
    const input = await normalizeCreateInput(raw)
    // A PDF session can show a document from anywhere: its folder only decides the
    // sidebar group it lands in. What it can read is that one file and nothing else
    // (see `editorRoot` below), so the file is settled here — an existing .pdf, made
    // absolute — before the session exists, and a refusal leaves nothing behind; the
    // dialog shows the reason.
    if (input.kind === 'pdf') {
      const file = typeof input.file === 'string' ? input.file.trim() : ''
      const abs = file ? await fsService.pdfFile(hostFolder(input), file) : null
      if (!abs) throw new Error("there's no PDF at that path")
      input.file = abs
      input.worktree = false
    }
    const session = state.createSession(input)
    // A Build/Run terminal reuses its project's path; that project is already in
    // recents from its first non-task session, so only remember on real sessions.
    // A session started *in* someone's worktree is the same story: the worktree
    // is that session's folder, not a project of its own, so keep it out of recents.
    const inKnownWorktree = state
      .listSessions()
      .some((x) => !!x.worktreePath && x.worktreePath === session.projectPath)
    if (!input.task && !inKnownWorktree) rememberProject(input.projectPath, input.projectName, input.runtime)
    // Create the worktree before returning so the PTY launches in it (any kind).
    if (input.worktree) {
      try {
        const path = await addWorktree(input.projectPath, session.branch, session.runtime)
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
    (_e, { id, cols, rows }: { id: string; cols?: number; rows?: number }) =>
      startSession(getWin(), id, { cols, rows }),
  )
  ipcMain.handle(Channels.sessionRemove, (_e, id: string) => state.removeSession(id))
  ipcMain.handle(
    Channels.sessionRename,
    (_e, { id, name }: { id: string; name: string }) => {
      state.updateSession(id, { name })
    },
  )
  // Written on every navigation in a browser pane, so a restart reopens the page
  // you were on. Validated here for the same reason a link is: the renderer is
  // reporting where a page went, and a page chooses that for itself.
  ipcMain.handle(Channels.sessionSetUrl, (_e, { id, url }: { id: string; url: string }) => {
    const s = state.getSession(id)
    if (!s || s.kind !== 'browser') return
    const safe = webUrl(url)
    if (safe) state.updateSession(id, { url: safe })
  })
  // Written as a PDF pane's reader moves through it (debounced on that side), so a
  // restart reopens the document on the page you were reading.
  ipcMain.handle(Channels.sessionSetPdfPage, (_e, { id, page }: { id: string; page: number }) => {
    const s = state.getSession(id)
    if (!s || s.kind !== 'pdf' || !Number.isInteger(page) || page < 1) return
    if (s.pdfPage !== page) state.updateSession(id, { pdfPage: page })
  })
  // The PDF pane's way out, the way a browser pane has "Open in your browser". The
  // path is the session's own, re-checked to still be there — never one the
  // renderer names.
  ipcMain.handle(Channels.pdfOpenOutside, async (_e, id: string) => {
    const s = state.getSession(id)
    if (!s || s.kind !== 'pdf' || !s.file) return { ok: false, reason: 'that session has no PDF' }
    const abs = await fsService.pdfFile(hostFolder(s), s.file)
    if (!abs) return { ok: false, reason: `${s.file} isn't there any more` }
    const err = await shell.openPath(abs)
    return err ? { ok: false, reason: err } : { ok: true }
  })
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
  ipcMain.handle(
    Channels.sessionOpenProjectEditor,
    (_e, { id, which }: { id: string; which?: FolderChoice }) => openProjectEditor(id, which),
  )
  ipcMain.handle(Channels.worktreeRemove, (_e, id: string) => removeWorktree(id))
  ipcMain.on(Channels.sessionClearNotified, (_e, id: string) => state.clearNotified(id))
  ipcMain.on(Channels.sessionReorder, (_e, ids: string[]) => state.reorderSessions(ids))

  // ---- conversation branching ----
  ipcMain.handle(Channels.sessionListPrompts, async (_e, id: string): Promise<TranscriptPrompt[]> => {
    const s = state.getSession(id)
    if (!s || s.kind !== 'claude') return []
    try {
      return await listPrompts(await transcriptDirFor(s.runtime, sessionFolder(s)), s.conversationId ?? s.id)
    } catch {
      return [] // a WSL distro that can't be reached has no prompts to offer
    }
  })

  // ---- conversation view ----
  // Same transcript, read as a document. The cwd is resolved here from the
  // session id, like every other path in this file — never taken from the renderer.
  ipcMain.handle(
    Channels.sessionConversation,
    async (_e, { id, from }: { id: string; from: number }): Promise<ConversationSlice> => {
      const s = state.getSession(id)
      const empty = { items: [], outputs: {}, nextOffset: 0, reset: false, exists: false }
      if (!s || s.kind !== 'claude') return empty
      const file = await conversationFile(s)
      return file ? readConversation(file, Math.max(0, from | 0)) : empty
    },
  )
  // Driving the session from that document: the prompt is typed into the pty,
  // because the TUI owns the only real input box. sendPrompt does its own
  // preflight (running Claude, not blocked on a dialog) and reports the reason.
  ipcMain.handle(
    Channels.sessionSendPrompt,
    (_e, { id, text }: { id: string; text: string }): SendPromptResult =>
      sendPrompt(id, typeof text === 'string' ? text : ''),
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
          worktreePath = await addWorktree(parent.projectPath, branchName, parent.runtime)
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
          // A branch runs where its parent does: its transcript is seeded there.
          runtime: parent.runtime,
          launchModel: parent.launchModel,
          launchEffort: parent.launchEffort,
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
      const newCwd = worktreePath || parent.projectPath
      const forked =
        input.keptPrompts > 0
          ? await transcriptDirFor(parent.runtime, parentCwd).then(
              async (parentDir) =>
                forkTranscript({
                  parentSessionId: parent.conversationId ?? parent.id,
                  parentDir,
                  parentCwd,
                  newSessionId: session.id,
                  newDir: await transcriptDirFor(parent.runtime, newCwd),
                  newCwd,
                  cutBeforeUuid: input.cutBeforeUuid,
                }),
              (e: unknown) => ({
                ok: false as const,
                reason: `couldn't reach the conversation: ${e instanceof Error ? e.message : String(e)}`,
              }),
            )
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
  ipcMain.on(Channels.ptyWrite, (_e, { id, data }: { id: string; data: string }) => {
    ptyMgr.writePty(id, data)
    userTyped(id, data)
  })
  ipcMain.on(
    Channels.ptyResize,
    (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) =>
      ptyMgr.resizePty(id, cols, rows),
  )

  // ---- attachments (paste / drag-and-drop) ----
  // `deliver` is normalised rather than trusted, like every other argument here:
  // only the exact string opts into typing at a live prompt.
  const how = (d: AttachDeliver | undefined): AttachDeliver => (d === 'caller' ? 'caller' : 'pty')
  ipcMain.handle(
    Channels.attachClipboard,
    (_e, { id, deliver }: { id: string; deliver?: AttachDeliver }) =>
      attachClipboardImage(id, how(deliver)),
  )
  ipcMain.handle(
    Channels.attachFiles,
    (_e, { id, files, deliver }: { id: string; files: AttachFileInput[]; deliver?: AttachDeliver }) =>
      attachFiles(id, files, how(deliver)),
  )
  // Acting on an attachment from its toast. Same posture as linkOpenFile, reached a
  // different way: the path can't be re-resolved from a session id (a dropped file
  // lies outside every session root), so instead only a path this process handed
  // back from an attach is accepted — see openAttachment.
  ipcMain.handle(Channels.attachOpen, (_e, path: string) => openAttachment(path))
  ipcMain.handle(Channels.attachReveal, (_e, path: string) => revealAttachment(path))

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

  // ---- the in-app browser's stored data (Settings -> IN-APP BROWSER) ----
  ipcMain.handle(Channels.browserCacheSize, () => browserCacheSize())
  ipcMain.handle(Channels.browserClear, (_e, what: BrowserClearWhat) => clearBrowserData(what))

  // ---- filesystem (editor sessions) ----
  // Root is resolved here from the session id — never trusted from the renderer.
  // A WSL session's files are read through its distro's share (\\wsl.localhost\…).
  // A PDF session's root is its one document, settled when it was made: it reaches
  // that file wherever it is, and nothing beside it — not even its folder.
  const editorRoot = (sessionId: string): string | null => {
    const s = state.getSession(sessionId)
    if (!s) return null
    if (s.kind === 'pdf') return s.file ?? null
    return hostFolder(s)
  }
  ipcMain.handle(Channels.fsList, (_e, { sessionId, dir }: { sessionId: string; dir: string }) => {
    const root = editorRoot(sessionId)
    return root ? fsService.listDir(root, dir) : []
  })
  ipcMain.handle(Channels.fsListFiles, (_e, { sessionId }: { sessionId: string }) => {
    const s = state.getSession(sessionId)
    if (!s) return { files: [], truncated: false }
    // A WSL session's git runs inside its distro, on the Linux path.
    const wsl = isWsl(s) ? { distro: s.runtime.distro, cwd: sessionFolder(s) } : undefined
    return fsService.listFiles(hostFolder(s), wsl)
  })
  ipcMain.handle(
    Channels.fsRead,
    (_e, { sessionId, path }: { sessionId: string; path: string }) => {
      const root = editorRoot(sessionId)
      return root ? fsService.readFile(root, path) : { ok: false as const, reason: 'missing' as const }
    },
  )
  ipcMain.handle(
    Channels.fsReadBytes,
    (_e, { sessionId, path }: { sessionId: string; path: string }) => {
      const root = editorRoot(sessionId)
      return root ? fsService.readBytes(root, path) : { ok: false as const, reason: 'missing' as const }
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

  // ---- Claude's Ctrl+G, opened in an Editor pane ----
  // Fire-and-forget on purpose: 'done' has to get through from teardown paths that
  // can't await, and a session waiting on a reply is a session nobody can unblock.
  ipcMain.on(
    Channels.promptEditReply,
    (_e, { file, verb }: { file: string; verb: 'opened' | 'done' }) => {
      if (verb === 'opened') markEditOpen(file)
      else finishEdit(file)
    },
  )
  ipcMain.handle(Channels.promptEditorStatus, () => promptEditorStatus())

  // ---- WSL ----
  ipcMain.handle(Channels.wslDistros, (_e, force?: boolean) => listDistros(!!force))
  ipcMain.handle(Channels.wslProbe, async (_e, { distro, force }: { distro: string; force?: boolean }) => {
    if (typeof distro !== 'string' || !distro.trim()) throw new Error('no distro named')
    // Only what the renderer shows; the rest is main's business.
    const { launchShell: _launch, exeLinux: _exe, ...shown } = await probe(distro.trim(), !!force)
    return shown
  })

  // ---- dialogs / settings ----
  ipcMain.handle(Channels.pickFolder, async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(getWin(), {
      properties: ['openDirectory', 'createDirectory'],
      ...(typeof defaultPath === 'string' && defaultPath ? { defaultPath } : {}),
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  // A bare title is the original form (Settings choosing a program); the object
  // form adds where the dialog opens and which files it lists (a PDF, say).
  ipcMain.handle(Channels.pickFile, async (_e, opts?: string | PickFileOptions) => {
    const o: PickFileOptions = typeof opts === 'string' ? { title: opts } : opts && typeof opts === 'object' ? opts : {}
    const filters = Array.isArray(o.filters)
      ? o.filters
          .filter((f) => f && typeof f.name === 'string' && Array.isArray(f.extensions))
          .map((f) => ({ name: f.name, extensions: f.extensions.filter((x) => typeof x === 'string') }))
      : undefined
    const r = await dialog.showOpenDialog(getWin(), {
      title: typeof o.title === 'string' && o.title ? o.title : 'Choose a program',
      properties: ['openFile'],
      ...(typeof o.defaultPath === 'string' && o.defaultPath ? { defaultPath: o.defaultPath } : {}),
      ...(filters?.length ? { filters } : {}),
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle(Channels.settingsGet, () => loadSettings())
  ipcMain.handle(Channels.settingsUpdate, (_e, patch) => {
    const next = saveSettings(patch)
    // Re-register the global hotkey in case it changed.
    applyGlobalShortcut(getWin)
    // Start or stop listening for the `terminator` command, in case that changed.
    applyScripting()
    // And push the user agent, in case that changed — pages already open keep the
    // old one until they navigate, which is the same deal a real browser offers.
    applyBrowserUserAgent()
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
  // Sent on every theme paint, the editor's live drafts included. Only Windows
  // has an overlay to recolour, and only hex gets through to it.
  ipcMain.on(Channels.windowTitleBar, (_e, colors: { color?: unknown; symbolColor?: unknown }) => {
    if (process.platform !== 'win32') return
    const { color, symbolColor } = colors ?? {}
    if (typeof color !== 'string' || !COLOR_RE.test(color)) return
    if (typeof symbolColor !== 'string' || !COLOR_RE.test(symbolColor)) return
    const win = getWin()
    if (win && !win.isDestroyed()) win.setTitleBarOverlay({ color, symbolColor })
  })

  // ---- scripting: the `terminator` command ----
  // The window says when it's listening, and answers the one request main hands it
  // (creating a session the New Session dialog's way). See scripting.ts.
  ipcMain.on(Channels.controlReady, () => rendererIsReady())
  ipcMain.on(Channels.controlReply, (_e, r: BridgeReply) => bridgeReply(r))
  ipcMain.handle(Channels.scriptingInfo, () => scriptingInfo())
  ipcMain.handle(Channels.scriptingAddToPath, () => addToPath())

  // ---- account-wide rate-limit usage ----
  // Read-only from here: the values are written by the statusLine reports arriving at
  // report-server.ts, and pushed out on Channels.usageUpdated.
  ipcMain.handle(Channels.usageGet, () => loadUsage())
}
