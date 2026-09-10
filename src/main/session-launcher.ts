import type { BrowserWindow } from 'electron'
import type { SessionMode, TaskCommand } from '../shared/types'
import { loadSettings } from './settings'
import * as ptyMgr from './pty-manager'
import {
  getSession,
  markStarted,
  resetTerminal,
  setRestarting,
  setStatus,
  setStopping,
  updateSession,
} from './state'
import { buildSettingsFile } from './hooks-config'
import { hasTranscript } from './transcript'
import { reportPort, reportToken } from './report-server'
import { shellRunArgs, quoteFor } from './shell'

export interface StartOpts {
  cols?: number
  rows?: number
}

export function startSession(win: BrowserWindow, id: string, opts: StartOpts = {}): void {
  const s = getSession(id)
  if (!s || s.alive) return
  // Editor sessions have no process — they render an in-app file browser/editor,
  // never a PTY. Return before any launch logic (otherwise a non-shell kind would
  // fall through to the Claude branch below).
  if (s.kind === 'editor') return
  const settings = loadSettings()
  const cwd = s.worktreePath || s.projectPath
  // A start from the sidebar has no pane to measure; lastSizeOf remembers the
  // size from the previous run (and falls back to 80x24 itself).
  const last = ptyMgr.lastSizeOf(id)
  const cols = opts.cols ?? last.cols
  const rows = opts.rows ?? last.rows

  if (s.kind === 'shell') {
    // Plain interactive shell. Build/Run dedicated terminals (s.task set) use this
    // same persistent shell; their command is typed in via runTaskCommand so the
    // prompt stays alive after it finishes.
    ptyMgr.createPty(win, { id, file: settings.defaultShell, args: settings.shellArgs, cwd, cols, rows })
    markStarted(id)
    setStatus(id, 'idle', 'idle')
    return
  }

  // Claude session: inject hooks + statusLine via a per-session --settings file,
  // force --session-id so hook/statusLine payloads map back to this session, and
  // run through the user's shell so the command resolves in their environment.
  const mode = s.mode === 'readonly' ? settings.modes.readonly : settings.modes.normal
  const settingsFile = buildSettingsFile(s)
  const parts = [mode.command, ...mode.extraArgs.map((a) => quoteFor(settings.defaultShell, a))]
  // --resume only works once a conversation exists. Before any prompt is sent the
  // id is unclaimed, so it must be set with --session-id (resuming an empty id
  // errors with "no conversation found", and re-claiming a used id also errors).
  // A branched session lands here too: its transcript was seeded on disk by
  // transcript.ts, so it resumes the conversation it was forked from.
  if (hasTranscript(s.id, cwd)) parts.push('--resume', s.id)
  else parts.push('--session-id', s.id)
  parts.push('--settings', quoteFor(settings.defaultShell, settingsFile))
  const command = parts.join(' ')

  ptyMgr.createPty(win, {
    id,
    file: settings.defaultShell,
    // Interactive shell so `.bashrc` aliases/functions (e.g. claude-readonly) resolve.
    args: shellRunArgs(settings.defaultShell, command, true),
    cwd,
    cols,
    rows,
    env: {
      // The reporter runs via our Electron binary in Node mode; Claude itself
      // ignores this var. Port/token are also passed as reporter argv.
      ELECTRON_RUN_AS_NODE: '1',
      TERMINATOR_PORT: String(reportPort()),
      TERMINATOR_TOKEN: reportToken(),
      TERMINATOR_SESSION_ID: s.id,
    },
  })
  markStarted(id)
  setStatus(id, 'idle', 'ready')
}

/**
 * Send a Build/Run/Stop command into a task terminal. The terminal is a normal
 * interactive shell that stays alive, so the command is typed at its prompt (not
 * run as a one-shot process). Starts the shell first if it isn't running yet.
 * 'stop' has no terminal of its own — callers pass the Run terminal's id.
 */
export function runTaskCommand(win: BrowserWindow, id: string, task: TaskCommand): void {
  const s = getSession(id)
  if (!s) return
  const settings = loadSettings()
  const proj = settings.projects.find((p) => p.path === s.projectPath)
  const cmd = (
    task === 'build' ? proj?.buildCommand : task === 'run' ? proj?.runCommand : proj?.stopCommand
  )?.trim()
  if (!cmd) return
  if (!s.alive) {
    startSession(win, id)
    // Let the freshly spawned shell finish loading rc files before we type.
    // Use \r (carriage return) not \n: PowerShell/conpty treats \n as a literal
    // newline in the input line, so the command isn't submitted until Enter is
    // pressed. \r is what terminals interpret as Enter across platforms.
    setTimeout(() => ptyMgr.writePty(id, `${cmd}\r`), 300)
  } else {
    ptyMgr.writePty(id, `${cmd}\r`)
  }
}

/**
 * Kill a running session's pty and start it again in the same terminal, at the
 * same size. Safe because pty-manager runs its exit listeners (which clear
 * `alive`) before the killPtyThen callback, so startSession's `s.alive` guard
 * doesn't reject the relaunch.
 */
function restartInPlace(win: BrowserWindow, id: string, activity: string): void {
  const { cols, rows } = ptyMgr.lastSizeOf(id)
  setRestarting(id, true)
  setStatus(id, 'busy', activity)
  ptyMgr.killPtyThen(id, () => {
    resetTerminal(id)
    startSession(win, id, { cols, rows })
  })
}

/**
 * Switch a Claude session between normal and read-only in one click, continuing
 * the same conversation: kill the current pty and relaunch the other mode command
 * with `--resume <same id>`. Re-uses the same terminal (cleared first).
 */
export function switchMode(win: BrowserWindow, id: string, newMode: SessionMode): void {
  const s = getSession(id)
  if (!s || s.kind !== 'claude' || s.mode === newMode) return
  updateSession(id, { mode: newMode })
  if (!s.alive) return // not running; the new mode applies when it next starts
  restartInPlace(win, id, `switching to ${newMode === 'readonly' ? 'read-only' : 'normal'}…`)
}

/**
 * End a session's process without touching the session itself — the row stays in
 * the sidebar and Start brings it back. `setStopping` is what keeps the exit from
 * being reported as an error (see state.ts); the exit handler does the rest.
 */
export function stopSession(id: string): void {
  const s = getSession(id)
  if (!s || !s.alive) return
  setStopping(id, true)
  setStatus(id, 'busy', 'stopping…')
  ptyMgr.killPty(id)
}

/** Restart a session's process. Starts it if it isn't running. Editors have none. */
export function relaunchSession(win: BrowserWindow, id: string): void {
  const s = getSession(id)
  if (!s || s.kind === 'editor') return
  if (!s.alive) {
    resetTerminal(id)
    startSession(win, id, ptyMgr.lastSizeOf(id))
    return
  }
  restartInPlace(win, id, 'relaunching…')
}
