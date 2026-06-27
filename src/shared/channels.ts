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
  sessionOpenGitGui: 'session:openGitGui',
  sessionClearNotified: 'session:clearNotified',
  sessionReorder: 'session:reorder',
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

  // dialogs / settings
  pickFolder: 'dialog:pickFolder',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
} as const
