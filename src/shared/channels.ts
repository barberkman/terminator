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
  sessionSetMode: 'session:setMode',
  sessionStop: 'session:stop',
  sessionRelaunch: 'session:relaunch',
  runTaskCommand: 'session:runTaskCommand',
  sessionOpenGitGui: 'session:openGitGui',
  sessionOpenInFolder: 'session:openInFolder',
  sessionClearNotified: 'session:clearNotified',
  sessionReorder: 'session:reorder',
  sessionListPrompts: 'session:listPrompts',
  sessionBranch: 'session:branch',
  sessionConversation: 'session:conversation',
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

  // filesystem (editor sessions)
  fsList: 'fs:list',
  fsRead: 'fs:read',
  fsWrite: 'fs:write',
  fsWatch: 'fs:watch',
  fsUnwatch: 'fs:unwatch',
  fsChanged: 'fs:changed',

  // dialogs / settings
  pickFolder: 'dialog:pickFolder',
  pickFile: 'dialog:pickFile',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  // the user's own themes (themes.json, kept apart from settings.json)
  themesGet: 'themes:get',
  themesSave: 'themes:save',
  globalShortcutStatus: 'globalShortcut:status',

  // account-wide rate-limit usage (usage.json). `usageUpdated` is a main -> renderer
  // event; it lives with its feature rather than in the events block above, the same
  // way `fsChanged` does.
  usageGet: 'usage:get',
  usageUpdated: 'usage:updated',
} as const
