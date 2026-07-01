import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { SessionMode } from '../shared/types'
import { loadSettings } from './settings'
import * as ptyMgr from './pty-manager'
import {
  getSession,
  markStarted,
  resetTerminal,
  setRestarting,
  setStatus,
  updateSession,
} from './state'
import { buildSettingsFile } from './hooks-config'
import { reportPort, reportToken } from './report-server'
import { shellRunArgs, quoteFor } from './shell'

export interface StartOpts {
  cols?: number
  rows?: number
}

/**
 * Whether Claude already has a saved conversation for this session id in cwd's
 * project. This is the ground truth for --resume vs --session-id (the in-memory
 * flag can't know it for sessions restored across an app restart). Claude stores
 * transcripts at ~/.claude/projects/<cwd-with-nonalnum-as-dash>/<id>.jsonl.
 */
function claudeHasConversation(sessionId: string, cwd: string): boolean {
  const abs = ptyMgr.expandHome(cwd) || cwd
  const encoded = abs.replace(/[^a-zA-Z0-9]/g, '-')
  return existsSync(join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`))
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
  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24

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
  if (claudeHasConversation(s.id, cwd)) parts.push('--resume', s.id)
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
 * Send a Build/Run command into its dedicated terminal. The terminal is a normal
 * interactive shell that stays alive, so the command is typed at its prompt (not
 * run as a one-shot process). Starts the shell first if it isn't running yet.
 */
export function runTaskCommand(win: BrowserWindow, id: string, task: 'build' | 'run'): void {
  const s = getSession(id)
  if (!s) return
  const settings = loadSettings()
  const proj = settings.projects.find((p) => p.path === s.projectPath)
  const cmd = (task === 'build' ? proj?.buildCommand : proj?.runCommand)?.trim()
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
 * Switch a Claude session between normal and read-only in one click, continuing
 * the same conversation: kill the current pty and relaunch the other mode command
 * with `--resume <same id>`. Re-uses the same terminal (cleared first).
 */
export function switchMode(win: BrowserWindow, id: string, newMode: SessionMode): void {
  const s = getSession(id)
  if (!s || s.kind !== 'claude' || s.mode === newMode) return
  updateSession(id, { mode: newMode })
  if (!s.alive) return // not running; the new mode applies when it next starts

  const { cols, rows } = ptyMgr.lastSizeOf(id)
  setRestarting(id, true)
  setStatus(id, 'busy', `switching to ${newMode === 'readonly' ? 'read-only' : 'normal'}…`)
  ptyMgr.killPtyThen(id, () => {
    resetTerminal(id)
    startSession(win, id, { cols, rows })
  })
}
