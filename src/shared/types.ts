// Shared types used across main / preload / renderer.

// ---- PTY (hot path) --------------------------------------------------------

export interface PtyData {
  id: string
  data: string
}

export interface PtyExit {
  id: string
  exitCode: number
  signal?: number
}

// ---- Sessions --------------------------------------------------------------

export type SessionKind = 'claude' | 'shell' | 'editor'
export type SessionMode = 'normal' | 'readonly'

/** Unified status. Claude uses all five; plain shells use busy(=running)/idle/closed. */
export type SessionStatus = 'busy' | 'waiting' | 'idle' | 'error' | 'closed'

/** Notification categories — passed to the configurable notification command. */
export type NotifType = 'waiting' | 'finished' | 'error' | 'exited'

export interface SessionMetrics {
  model?: string
  effort?: string
  contextPct?: number
  contextTokens?: number
  contextLimit?: number
  costUsd?: number
  /** 5-hour rate-limit window usage. */
  usagePct?: number
  usageResetsAt?: string
  /** 7-day (weekly) rate-limit window usage. */
  weeklyUsagePct?: number
  weeklyResetsAt?: string
}

/**
 * Account-wide rate-limit usage, kept globally rather than per-session (the
 * limits are per-account, so any Claude session reports the same numbers). The
 * percentages come from Claude Code's statusLine; the reset timestamps drive a
 * live countdown in the footer.
 */
export interface GlobalUsage {
  /** 5-hour rate-limit window usage percentage. */
  fiveHourPct?: number
  /** ISO timestamp when the 5-hour window resets. */
  fiveHourResetsAt?: string
  /** 7-day (weekly) rate-limit window usage percentage. */
  weeklyPct?: number
  /** ISO timestamp when the weekly window resets. */
  weeklyResetsAt?: string
  /** When we last received a report (Date.now()); absent = never reported. */
  updatedAt?: number
}

export interface Session {
  id: string
  name: string
  kind: SessionKind
  mode: SessionMode
  /** When set, this shell session runs the configured build/run command (in a transient pane). */
  task?: 'build' | 'run'
  projectName: string
  projectPath: string
  branch: string
  /** Set when the app created a git worktree for this session. */
  worktreePath?: string
  status: SessionStatus
  /** Human-readable current activity, e.g. "waiting for input", "running tests". */
  activity: string
  /** True between a notable event firing and the user viewing the session. */
  notified: boolean
  /** True while the PTY process is running. */
  alive: boolean
  /** Whether the session was ever started (so a restored, never-started session reads differently). */
  everStarted: boolean
  metrics?: SessionMetrics
  createdAt: number
}

export interface CreateSessionInput {
  kind: SessionKind
  mode: SessionMode
  name?: string
  projectPath: string
  projectName?: string
  worktree?: boolean
  branch?: string
  /** Spawn a transient shell session that runs the configured build/run command. */
  task?: 'build' | 'run'
}

// ---- Settings --------------------------------------------------------------

export interface ModeConfig {
  command: string
  extraArgs: string[]
}

export interface NotificationSettings {
  /** Command run on each (triggering) notification, via the user's shell. Empty = disabled. */
  command: string
  /** Which notification types fire the command. */
  triggerOn: NotifType[]
  /** Optional per-type command overrides; falls back to `command`. */
  perType: Partial<Record<NotifType, string>>
}

/** A remembered project and its per-project Build/Run commands. */
export interface ProjectConfig {
  name: string
  path: string
  /** Command run by this project's sidebar Build button. Empty/unset = disabled. */
  buildCommand?: string
  /** Command run by this project's sidebar Run button. Empty/unset = disabled. */
  runCommand?: string
}

export interface Settings {
  modes: {
    normal: ModeConfig
    readonly: ModeConfig
  }
  defaultShell: string
  shellArgs: string[]
  gitGuiCommand: string
  worktreesRoot: string
  projects: ProjectConfig[]
  notifications: NotificationSettings
  /** CSS font-family applied to the terminal (xterm) panes. */
  terminalFont: string
  /** Global UI size — scales the whole interface via zoom (14 = 100%). */
  fontSize: number
  /** Extra scale applied to icons and their button boxes only (100 = default). Multiplies on top of the global zoom. */
  iconScale: number
  /** Which side of the window the session sidebar sits on. */
  sidebarSide: 'left' | 'right'
  /** Electron accelerator for the global show/hide hotkey. Empty = disabled. */
  globalToggleShortcut: string
  /** Single freeform markdown note, edited from Settings → Notes. */
  notes: string
  /** How often (seconds) the footer usage countdown re-renders. */
  usageRefreshSeconds: number
}

// ---- Notifications ---------------------------------------------------------

export interface NotificationEvent {
  type: NotifType
  sessionId: string
  name: string
  project: string
  branch: string
  status: SessionStatus
  kind: SessionKind
  mode: SessionMode
  cwd: string
  message: string
  timestamp: number
}

// ---- Filesystem (Editor sessions) ------------------------------------------

/** One entry in a directory listing. */
export interface DirEntry {
  name: string
  isDir: boolean
}

/** Result of reading a file: either its text, or why it can't be shown. */
export type FileReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'binary' | 'tooLarge' | 'missing' }

/** A watched path changed on disk. `dir` re-lists a directory; the rest touch a file. */
export interface FsChange {
  sessionId: string
  path: string
  kind: 'modified' | 'removed' | 'dir'
}

// ---- Renderer-facing API (window.terminator) -------------------------------

export interface TerminatorApi {
  ping(): Promise<string>

  // sessions
  listSessions(): Promise<Session[]>
  createSession(input: CreateSessionInput): Promise<Session>
  startSession(id: string, cols: number, rows: number): Promise<void>
  removeSession(id: string): Promise<void>
  renameSession(id: string, name: string): Promise<void>
  setMode(id: string, mode: SessionMode): Promise<void>
  /** Type the Build/Run command into its dedicated terminal (starting it if needed). */
  runTaskCommand(id: string, task: 'build' | 'run'): Promise<void>
  openGitGui(id: string): Promise<void>
  openInFolder(id: string): Promise<void>
  removeWorktree(id: string): Promise<void>
  clearNotified(id: string): void
  /** Persist a new full session order (used by sidebar drag-reorder). */
  reorderSessions(ids: string[]): void

  // pty hot path
  writePty(id: string, data: string): void
  resizePty(id: string, cols: number, rows: number): void
  onPtyData(cb: (p: PtyData) => void): () => void
  onPtyExit(cb: (p: PtyExit) => void): () => void
  onPtyReset(cb: (id: string) => void): () => void

  // session metadata events
  onSessionUpdated(cb: (s: Session) => void): () => void
  onSessionRemoved(cb: (id: string) => void): () => void
  onNavJump(cb: (id: string) => void): () => void

  // filesystem (editor sessions) — every op is scoped to the session's root
  fsList(sessionId: string, dir: string): Promise<DirEntry[]>
  fsRead(sessionId: string, path: string): Promise<FileReadResult>
  fsWrite(sessionId: string, path: string, content: string): Promise<void>
  fsWatch(sessionId: string, path: string): void
  fsUnwatch(sessionId: string, path: string): void
  onFsChanged(cb: (c: FsChange) => void): () => void

  // global usage (account-wide rate limits)
  getUsage(): Promise<GlobalUsage>
  onUsageUpdated(cb: (u: GlobalUsage) => void): () => void

  // dialogs / settings
  pickFolder(): Promise<string | null>
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  getGlobalShortcutStatus(): Promise<{ accelerator: string; registered: boolean }>

  // UI zoom (global font scaling)
  setZoom(factor: number): void
  getZoom(): number

  // clipboard (terminal copy/paste)
  clipboardWrite(text: string): void
  clipboardRead(): string
}

/** `fontSize` value that corresponds to 100% zoom (the as-designed sizing). */
export const UI_BASE_FONT_SIZE = 14

/** `iconScale` value that corresponds to the as-designed icon/button sizing. */
export const UI_BASE_ICON_SCALE = 100
