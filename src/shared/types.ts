import type { ThemeOverrides } from './themes'

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
 * What a task button types into a project terminal. 'build' and 'run' each own a
 * dedicated terminal (`Session.task`); 'stop' has none of its own — it targets the
 * project's existing Run terminal.
 */
export type TaskCommand = 'build' | 'run' | 'stop'

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
  /** Set when this session was branched off another Claude session's conversation. */
  parentId?: string
  /** The parent's name at branch time — so the label survives the parent being removed. */
  branchedFrom?: string
  /** How many of the parent's prompts this branch carries over (display only). */
  branchPoint?: number
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

/** One prompt the user typed, read out of a Claude session's transcript. */
export interface TranscriptPrompt {
  /** 1-based position among the session's human prompts. */
  index: number
  uuid: string
  text: string
  /** ISO timestamp, or '' when the record didn't carry one. */
  timestamp: string
}

export interface BranchSessionInput {
  parentId: string
  /**
   * uuid of the first prompt to leave behind — the branch is cut in the gap
   * *before* it. null branches at the tip (carries the whole conversation).
   */
  cutBeforeUuid: string | null
  /** How many parent prompts the branch carries (display only). */
  keptPrompts: number
  name?: string
  /** Run the branch in its own git worktree instead of the parent's folder. */
  worktree?: boolean
  branch?: string
  /** Text to drop into the new session's input box, unsent, once it's ready. */
  prefill?: string
}

export type BranchResult = { ok: true; session: Session } | { ok: false; reason: string }

// ---- Conversation view (Claude transcript, rendered as a document) ----------

/** One part of a tool call worth reading when its row is opened. */
export interface ToolField {
  label: string
  text: string
  /** Render as a code block (monospace, copy button) rather than a plain line. */
  code: boolean
  /** True when `text` was cut to keep the payload sane — say so next to it. */
  clipped: boolean
}

/** What a tool call returned, keyed to the call by `ConversationItem.toolId`. */
export interface ToolOutput {
  text: string
  isError: boolean
  clipped: boolean
}

/**
 * One thing to show in a session's conversation. Prose and prompts are the
 * conversation; thinking and tool calls are the working, shown collapsed.
 */
export type ConversationItem =
  | { kind: 'prompt'; id: string; ts: string; text: string }
  | { kind: 'text'; id: string; ts: string; text: string }
  | { kind: 'thinking'; id: string; ts: string; text: string }
  | {
      kind: 'tool'
      id: string
      ts: string
      /** The `tool_use` id its output is filed under. */
      toolId: string
      name: string
      /** One line standing in for the call — the command, the path, the pattern. */
      summary: string
      fields: ToolField[]
    }

/**
 * Everything appended to a transcript since a byte offset. Reads are incremental:
 * hand `nextOffset` back on the following call and only new records come across.
 */
export interface ConversationSlice {
  items: ConversationItem[]
  /** Tool output that arrived in this slice, keyed by `toolId`. */
  outputs: Record<string, ToolOutput>
  /** Byte offset to pass as `from` next time. */
  nextOffset: number
  /** The file restarted (shrank or was replaced): discard what you had. */
  reset: boolean
  /** False when the session has no saved conversation on disk (yet). */
  exists: boolean
}

// ---- Attachments (paste / drag-and-drop) -----------------------------------

/** One thing that was handed to a session — a pasted image or a dropped path. */
export interface AttachedItem {
  /** Basename, for the confirmation toast. */
  name: string
  /** Absolute path that was typed into the session. */
  path: string
  kind: 'image' | 'file' | 'dir'
  /** Small data: URL preview — images only, and only when one could be rendered. */
  thumb?: string
}

/**
 * A file to attach. Dropped files carry a `path` and are referenced where they
 * lie; a file with no path (dragged out of a browser, say) exists only as bytes,
 * so it has to be written to the attachments folder before it can be referenced.
 */
export interface AttachFileInput {
  path?: string
  name?: string
  bytes?: Uint8Array
}

/** Attaching is all-or-nothing per drop/paste: on failure nothing was typed. */
export type AttachResult =
  | { ok: true; items: AttachedItem[]; note?: string }
  | { ok: false; reason: string }

// ---- Links (clickable URLs in terminal output) -----------------------------

/** One browser a link can be opened with. */
export interface BrowserOption {
  /** Stable id — what `LinkSettings.defaultBrowserId` points at. */
  id: string
  /** Shown in the hover tooltip and the right-click menu ("Chrome incognito"). */
  name: string
  /**
   * The executable itself, never a command line. Kept apart from `args` so a path
   * with spaces (`C:\Program Files\...`) needs no quoting and is never re-split:
   * it goes to spawn() as argv[0] verbatim, with no shell in between.
   */
  command: string
  /** Flags passed before the URL, e.g. `["--incognito"]`. */
  args: string[]
}

/**
 * The program a file path printed in terminal output opens in. Same split as
 * `BrowserOption`: the executable is kept apart from its arguments, so a path
 * with spaces needs no quoting and is never re-split.
 */
export interface EditorOption {
  /** The executable itself, never a command line. Empty = use an Editor pane. */
  command: string
  /**
   * Arguments placed before the file. `{path}`, `{line}` and `{column}` are
   * substituted wherever they appear; an argument mentioning `{line}` is dropped
   * when the path carried no line number, and if no argument mentions `{path}`
   * the file is appended last. That covers the usual spellings — VS Code
   * (`-g {path}:{line}`), Notepad++ (`-n{line}`), vim (`+{line}`) — and a bare
   * command with no arguments at all.
   */
  args: string[]
}

export interface LinkSettings {
  /** Off = terminal output is inert text again: no underline, no hover, no click. */
  enabled: boolean
  browsers: BrowserOption[]
  /** Which browser a plain click uses. Empty (or unknown) = the OS default handler. */
  defaultBrowserId: string
  /** Also linkify file paths, which open in an editor instead of a browser. */
  openFilePaths: boolean
  /**
   * External editor for clicked file paths. With no command set, a click opens an
   * in-app Editor pane instead — which needs one covering that project.
   */
  editor: EditorOption
}

/** Nothing opens silently: either it launched, or there's a reason to show. */
export type OpenLinkResult = { ok: true; browser: string } | { ok: false; reason: string }

/** Same bargain for a file: `editor` names what opened it, for the tooltip's promise. */
export type OpenFileResult = { ok: true; editor: string } | { ok: false; reason: string }

/** A file path a session printed, as the renderer asks for it to be opened. */
export interface OpenFileInput {
  /** Whose folder the path must live in — the main process re-checks it. */
  sessionId: string
  path: string
  line?: number
  column?: number
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

/** A remembered project and its per-project Build/Run/Stop commands. */
export interface ProjectConfig {
  name: string
  path: string
  /** Command run by this project's sidebar Build button. Empty/unset = disabled. */
  buildCommand?: string
  /** Command run by this project's sidebar Run button. Empty/unset = disabled. */
  runCommand?: string
  /** Command typed into this project's Run terminal by the Stop button. Empty/unset = disabled. */
  stopCommand?: string
}

/** Where pasted images land, and who is allowed to read them. */
export interface AttachmentSettings {
  /**
   * Add the attachments folder to each Claude session's allowed directories (via
   * the per-session --settings file), so reading a pasted image never needs a
   * permission prompt. Off = Claude asks the first time it reads one.
   */
  allowClaudeRead: boolean
  /** Pasted images older than this are deleted at startup. 0 disables pruning. */
  keepDays: number
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
  /** Id of the active colour theme (see shared/themes.ts). Unknown ids fall back to the default. */
  theme: string
  /** Optional per-token colour overrides laid over the selected theme. Edited on disk. */
  customTheme?: ThemeOverrides
  /** Electron accelerator for the global show/hide hotkey. Empty = disabled. */
  globalToggleShortcut: string
  /** Electron accelerator to toggle the Notes overlay (renderer-side). Empty = disabled. */
  notesShortcut: string
  /** Single freeform markdown note, edited from Settings → Notes. */
  notes: string
  attachments: AttachmentSettings
  links: LinkSettings
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
  /** Type the Build/Run/Stop command into the task's terminal (starting it if needed). */
  runTaskCommand(id: string, task: TaskCommand): Promise<void>
  openGitGui(id: string): Promise<void>
  openInFolder(id: string): Promise<void>
  removeWorktree(id: string): Promise<void>
  clearNotified(id: string): void
  /** Persist a new full session order (used by sidebar drag-reorder). */
  reorderSessions(ids: string[]): void
  /** The prompts a Claude session's saved conversation contains (branch points). */
  listPrompts(id: string): Promise<TranscriptPrompt[]>
  /** Fork a Claude session's conversation into a new sibling session. */
  branchSession(input: BranchSessionInput): Promise<BranchResult>
  /**
   * A Claude session's conversation, from byte offset `from` to the end of its
   * transcript. Pass 0 for the whole thing, then the returned `nextOffset`.
   */
  readConversation(id: string, from: number): Promise<ConversationSlice>

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

  // dialogs / settings
  pickFolder(): Promise<string | null>
  /** Pick a single file (used to choose a browser executable). */
  pickFile(title?: string): Promise<string | null>
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  getGlobalShortcutStatus(): Promise<{ accelerator: string; registered: boolean }>

  // UI zoom (global font scaling)
  setZoom(factor: number): void
  getZoom(): number

  // clipboard (terminal copy/paste)
  clipboardWrite(text: string): void
  clipboardRead(): string
  /** True when the clipboard holds a bitmap (checked before every Ctrl/Cmd+V). */
  clipboardHasImage(): boolean

  // links (clickable URLs / paths in terminal output)
  /**
   * Open a link from terminal output. The URL is re-validated in the main process
   * (http/https only) before anything is launched — output is never trusted.
   * `browserId` picks a configured browser; omitted uses the configured default.
   */
  openLink(url: string, browserId?: string): Promise<OpenLinkResult>
  /**
   * Absolute path for a path-like token printed by a session, or null when it
   * doesn't resolve to a file inside that session's folder.
   */
  resolveOutputPath(sessionId: string, token: string): Promise<string | null>
  /**
   * Open a file a session printed in the configured external editor. The path is
   * re-resolved against that session's folder in the main process, so what was
   * on screen is a suggestion, not permission to open anything.
   */
  openFileInEditor(input: OpenFileInput): Promise<OpenFileResult>

  // attachments
  /** Save the clipboard image to disk and reference it in the session. */
  attachClipboardImage(id: string): Promise<AttachResult>
  /** Reference dropped files in the session. Files on disk are never copied. */
  attachFiles(id: string, files: AttachFileInput[]): Promise<AttachResult>
  /** Absolute path of a dropped File ('' when it has none, e.g. a browser drag). */
  pathForFile(file: File): string
}

/** `fontSize` value that corresponds to 100% zoom (the as-designed sizing). */
export const UI_BASE_FONT_SIZE = 14

/** `iconScale` value that corresponds to the as-designed icon/button sizing. */
export const UI_BASE_ICON_SCALE = 100
