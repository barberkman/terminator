// Single source of truth for IPC channel names, shared by main, preload, renderer.
export const Channels = {
  // app
  ping: 'app:ping',

  // sessions (renderer -> main, invoke)
  sessionList: 'session:list',
  sessionCreate: 'session:create',
  sessionStart: 'session:start',
  sessionRemove: 'session:remove',
  sessionRename: 'session:rename',
  sessionSetUrl: 'session:setUrl',
  sessionSetPdfPage: 'session:setPdfPage',
  sessionSetMode: 'session:setMode',
  sessionStop: 'session:stop',
  sessionRelaunch: 'session:relaunch',
  runTaskCommand: 'session:runTaskCommand',
  sessionOpenGitGui: 'session:openGitGui',
  sessionOpenInFolder: 'session:openInFolder',
  sessionOpenProjectEditor: 'session:openProjectEditor',
  sessionClearNotified: 'session:clearNotified',
  sessionReorder: 'session:reorder',
  sessionListPrompts: 'session:listPrompts',
  sessionBranch: 'session:branch',
  sessionConversation: 'session:conversation',
  sessionSendPrompt: 'session:sendPrompt',
  worktreeRemove: 'worktree:remove',

  // pty hot path
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  ptyReset: 'pty:reset',

  // main -> renderer (events)
  sessionUpdated: 'session:updated',
  sessionRemoved: 'session:removed',
  notify: 'session:notify',
  navJump: 'nav:jump',

  // attachments (paste / drag-and-drop into a session)
  attachClipboard: 'attach:clipboard',
  attachFiles: 'attach:files',
  attachOpen: 'attach:open',
  attachReveal: 'attach:reveal',

  // links (clickable URLs / paths in terminal output)
  linkOpen: 'link:open',
  linkResolvePath: 'link:resolvePath',
  linkOpenFile: 'link:openFile',

  // the in-app browser's persistent session (Settings -> IN-APP BROWSER)
  browserCacheSize: 'browser:cacheSize',
  browserClear: 'browser:clear',
  // main -> renderer: Ctrl/Cmd+F pressed inside a guest page. The payload is the
  // guest's webContents id; the pane that owns that guest opens its find bar.
  browserFind: 'browser:find',
  // main -> renderer: Alt+1..9 or Alt+Up/Down pressed inside a guest page. The
  // payload is the key's `code`; the window switches session as if it had seen it.
  browserSessionKey: 'browser:sessionKey',

  // Claude's Ctrl+G, when Settings points it at an Editor pane. main -> renderer
  // opens the prompt in a tab; the reply releases the session, which is blocked
  // for the whole round trip (see main/prompt-edit.ts).
  promptEdit: 'promptEdit:open',
  promptEditEnded: 'promptEdit:ended',
  promptEditReply: 'promptEdit:reply',
  promptEditorStatus: 'promptEdit:status',

  // filesystem (editor sessions)
  fsList: 'fs:list',
  fsListFiles: 'fs:list-files',
  fsRead: 'fs:read',
  fsReadBytes: 'fs:read-bytes',
  fsWrite: 'fs:write',
  fsWatch: 'fs:watch',
  fsUnwatch: 'fs:unwatch',
  fsChanged: 'fs:changed',

  // a PDF pane's way out: its document in the OS's own viewer
  pdfOpenOutside: 'pdf:openOutside',

  // WSL distros (listing, and what a distro says about itself)
  wslDistros: 'wsl:distros',
  wslProbe: 'wsl:probe',

  // dialogs / settings
  pickFolder: 'dialog:pickFolder',
  pickFile: 'dialog:pickFile',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  // main -> renderer: settings, themes or the sync folder moved under the window —
  // a git pull, or main saving something on its own (a remembered project).
  settingsChanged: 'settings:changed',
  syncStatus: 'settings:syncStatus',

  // the user's own themes (themes.json, kept apart from settings.json)
  themesGet: 'themes:get',
  themesSave: 'themes:save',
  // Windows only: the caption buttons are native, so their colours come via main.
  windowTitleBar: 'window:titleBar',
  globalShortcutStatus: 'globalShortcut:status',

  // scripting: the `terminator` command (control-server.ts, scripting.ts). The
  // request/reply pair carries the one command main needs the window for —
  // creating a session the New Session dialog's way — and `controlReady` says the
  // window is listening. `controlQuiet` (main -> renderer) marks a session that a
  // script's action put on screen, so it doesn't take the keyboard.
  controlRequest: 'control:request',
  controlReply: 'control:reply',
  controlReady: 'control:ready',
  controlQuiet: 'control:quiet',
  scriptingInfo: 'scripting:info',
  scriptingAddToPath: 'scripting:addToPath',

  // account-wide rate-limit usage (usage.json). `usageUpdated` is a main -> renderer
  // event; it lives with its feature rather than in the events block above, the same
  // way `fsChanged` does.
  usageGet: 'usage:get',
  usageUpdated: 'usage:updated',
} as const
