import { homedir } from 'node:os'
import type { BrowserWindow } from 'electron'
import { isProcessless, type Session, type SessionMode, type TaskCommand } from '../shared/types'
import { findProject, isWsl, sessionFolder } from '../shared/wsl-path'
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
import { hasTranscript, transcriptDirFor, transcriptExists, windowsTranscriptDir } from './transcript'
import { finishEditsForSession, promptEditorCommand, promptEditorCommandFor } from './prompt-edit'
import { reportPort, reportToken } from './report-server'
import { shellRunArgs, quoteFor, shquote } from './shell'
import { readyProbe, reap, reapDetached, winToLinux, wslExe } from './wsl'

export interface StartOpts {
  cols?: number
  rows?: number
}

/**
 * Start a session's process. Returns a promise, but deliberately isn't `async`: a
 * Windows session reaches its pty synchronously, exactly as it always has (the
 * Build/Run timer in `runTaskCommand` counts on that), and only a WSL session —
 * which has to ask its distro a few things first — actually waits on anything.
 */
export function startSession(win: BrowserWindow, id: string, opts: StartOpts = {}): Promise<void> {
  const s = getSession(id)
  if (!s || s.alive) return Promise.resolve()
  // Editor and browser sessions have no process — one renders an in-app file
  // browser/editor, the other a web page. Return before any launch logic (otherwise
  // a non-shell kind would fall through to the Claude branch below).
  if (isProcessless(s.kind)) return Promise.resolve()
  if (isWsl(s)) return startWsl(win, id, opts)
  startWindows(win, s, opts)
  return Promise.resolve()
}

function startWindows(win: BrowserWindow, s: Session, opts: StartOpts): void {
  const id = s.id
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
  const promptEditor = promptEditorCommand()
  const settingsFile = buildSettingsFile(s)
  const parts = [mode.command, ...mode.extraArgs.map((a) => quoteFor(settings.defaultShell, a))]
  // --resume only works once a conversation exists. Before any prompt is sent the
  // id is unclaimed, so it must be set with --session-id (resuming an empty id
  // errors with "no conversation found", and re-claiming a used id also errors).
  // A branched session lands here too: its transcript was seeded on disk by
  // transcript.ts, so it resumes the conversation it was forked from.
  if (hasTranscript(windowsTranscriptDir(cwd), s.id)) parts.push('--resume', s.id)
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
      // Ctrl+G's editor, but only when Settings asks for an Editor pane. Spread
      // rather than set, because pty-manager merges this over the real
      // environment: a `VISUAL: ''` would *clear* the user's own $VISUAL and
      // quietly move their Ctrl+G, which is the one thing this feature promises
      // not to do. Read here rather than at the keypress, which is why the
      // setting reaches a session only when that session starts.
      ...(promptEditor ? { VISUAL: promptEditor } : {}),
    },
  })
  markStarted(id)
  setStatus(id, 'idle', 'ready')
}

// ---- WSL ---------------------------------------------------------------------
//
// A WSL session is a wsl.exe pty: `wsl.exe -d <distro> --cd <linux cwd>`, which on
// its own is the user's normal login shell in that folder. A Claude session adds
// `--exec <shell> -l -i -c 'eval "$TERMINATOR_LAUNCH"'`, with the whole command in
// that environment variable rather than in argv:
//
//   • argv goes through a Windows command line that wsl.exe parses back; a command
//     full of quotes needn't survive that round trip, while an environment variable
//     arrives byte for byte (`WSLENV` carries it across, `/u` one way only).
//   • The command starts by exporting what the session needs — the report port and
//     token, its id, and $VISUAL for Ctrl+G. Exported *after* the shell's rc files
//     have run, so a `.bashrc` that sets its own VISUAL can't quietly win.
//   • `eval`, not `exec`: a `claude-readonly` alias in `.bashrc` has to resolve,
//     which is why the shell is interactive at all.
//   • The session id then appears in exactly one command line in the distro — Claude's
//     own — which is what lets `reap` find a leftover one.

/** Starts in flight. A second Start while the first is still asking its distro is dropped. */
const starting = new Map<string, { cancelled: boolean }>()
/** The distro and kind of each running WSL pty, captured at spawn: a removed session is gone before its exit arrives. */
const liveWsl = new Map<string, { distro: string; kind: Session['kind'] }>()
/** Reaps still running for an exited WSL Claude. Its next start waits on one. */
const reaping = new Map<string, Promise<void>>()

/** `extra` merged into the pty's environment, each name also listed in WSLENV so it reaches Linux. */
function wslEnv(extra: Record<string, string>): Record<string, string> {
  const names = Object.keys(extra).map((k) => `${k}/u`)
  const existing = (process.env.WSLENV ?? '').split(':').filter(Boolean)
  return { ...extra, WSLENV: [...existing, ...names].join(':') }
}

async function startWsl(win: BrowserWindow, id: string, opts: StartOpts): Promise<void> {
  if (starting.has(id)) return
  const ticket = { cancelled: false }
  starting.set(id, ticket)
  /** Still worth starting: not stopped, removed or already started meanwhile. */
  const wanted = (): Session | null => {
    const cur = getSession(id)
    return !ticket.cancelled && cur && !cur.alive && isWsl(cur) ? cur : null
  }
  try {
    setStatus(id, 'busy', 'starting…')
    // A relaunch lands here straight after the old pty exited; wait until whatever
    // it left behind in the distro is gone, so two Claudes never share a transcript.
    await reaping.get(id)
    let s = wanted()
    if (!s) return
    const distro = s.runtime!.distro
    const p = await readyProbe(distro)
    s = wanted()
    if (!s) return

    const cwd = sessionFolder(s)
    const last = ptyMgr.lastSizeOf(id)
    const cols = opts.cols ?? last.cols
    const rows = opts.rows ?? last.rows
    const base = ['-d', p.distro, '--cd', cwd]

    if (s.kind === 'shell') {
      ptyMgr.createPty(win, {
        id,
        file: wslExe(),
        args: base,
        cwd: homedir(),
        cols,
        rows,
        env: wslEnv({ COLORTERM: 'truecolor' }),
      })
      liveWsl.set(id, { distro: p.distro, kind: s.kind })
      markStarted(id)
      setStatus(id, 'idle', 'idle')
      return
    }

    const settings = loadSettings()
    const mode = s.mode === 'readonly' ? settings.modes.readonly : settings.modes.normal
    const command =
      (s.mode === 'readonly' ? settings.wsl.claudeReadonlyCommand : settings.wsl.claudeCommand).trim() ||
      mode.command
    const settingsFile = winToLinux(p, buildSettingsFile(s, p))
    if (!settingsFile) throw new Error(`${p.distro} can't reach this app's settings folder (is /mnt/c mounted?)`)
    const resume = await transcriptExists(await transcriptDirFor(s.runtime, cwd), s.id)
    const visual = await promptEditorCommandFor(s, p)
    s = wanted()
    if (!s) return

    const exports: Record<string, string> = {
      TERMINATOR_PORT: String(reportPort()),
      TERMINATOR_TOKEN: reportToken(),
      TERMINATOR_SESSION_ID: s.id,
      COLORTERM: 'truecolor',
      ...(visual ? { VISUAL: visual } : {}),
    }
    const claude = [
      command,
      ...mode.extraArgs.map(shquote),
      resume ? '--resume' : '--session-id',
      s.id,
      '--settings',
      shquote(settingsFile),
    ].join(' ')
    const launch = [
      'unset TERMINATOR_LAUNCH',
      `export ${Object.entries(exports)
        .map(([k, v]) => `${k}=${shquote(v)}`)
        .join(' ')}`,
      claude,
    ].join('; ')

    ptyMgr.createPty(win, {
      id,
      file: wslExe(),
      args: [...base, '--exec', p.launchShell, '-l', '-i', '-c', 'eval "$TERMINATOR_LAUNCH"'],
      cwd: homedir(),
      cols,
      rows,
      env: wslEnv({ TERMINATOR_LAUNCH: launch }),
    })
    liveWsl.set(id, { distro: p.distro, kind: s.kind })
    markStarted(id)
    // Status comes back through interop. Without it the session still runs, it just
    // can't say what it's doing — so say that, rather than sit on "ready" forever.
    setStatus(id, 'idle', p.interop && p.exeReachable ? 'ready' : 'ready · no status (WSL interop is off)')
  } catch (e) {
    if (getSession(id) && !ticket.cancelled) {
      const why = e instanceof Error ? e.message : String(e)
      setStatus(id, 'error', why.slice(0, 160))
    }
  } finally {
    if (starting.get(id) === ticket) starting.delete(id)
  }
}

/**
 * Reap what an exited WSL Claude left behind (see `reap` in wsl.ts). Registered on
 * the pty's exit listeners, which run before a relaunch's `killPtyThen` callback —
 * so the reap is on record by the time the relaunch looks for it.
 */
export function wireLauncher(): void {
  // Whatever kind or runtime: a session that has exited isn't waiting on a Ctrl+G tab.
  ptyMgr.onExit((id) => finishEditsForSession(id))
  ptyMgr.onExit((id) => {
    const live = liveWsl.get(id)
    if (!live) return
    liveWsl.delete(id)
    if (live.kind !== 'claude') return
    const done: Promise<void> = reap(live.distro, id)
      .catch(() => {})
      .finally(() => {
        if (reaping.get(id) === done) reaping.delete(id)
      })
    reaping.set(id, done)
  })
}

/** Quit: the ptys are already being killed; make sure no Claude outlives them in a distro. */
export function reapAllOnQuit(): void {
  const byDistro = new Map<string, string[]>()
  for (const [id, live] of liveWsl) {
    if (live.kind !== 'claude') continue
    byDistro.set(live.distro, [...(byDistro.get(live.distro) ?? []), id])
  }
  for (const [distro, ids] of byDistro) reapDetached(distro, ids)
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
  const proj = findProject(settings.projects, s.projectPath, s.runtime)
  const cmd = (
    task === 'build' ? proj?.buildCommand : task === 'run' ? proj?.runCommand : proj?.stopCommand
  )?.trim()
  if (!cmd) return
  if (!s.alive && isWsl(s)) {
    // A WSL shell may be booting its distro first, so "300 ms" means nothing here:
    // type once it has printed its prompt and gone quiet.
    void startSession(win, id)
      .then(() => ptyMgr.whenOutput(id, { quietMs: 300, timeoutMs: 10_000 }))
      .then(() => ptyMgr.writePty(id, `${cmd}\r`))
    return
  }
  if (!s.alive) {
    void startSession(win, id)
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
    void startSession(win, id, { cols, rows })
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
  // A WSL start still asking its distro has no pty to kill yet: call it off instead.
  const pending = starting.get(id)
  if (s && pending && !s.alive) {
    pending.cancelled = true
    starting.delete(id)
    setStatus(id, 'closed', 'stopped')
    return
  }
  if (!s || !s.alive) return
  setStopping(id, true)
  setStatus(id, 'busy', 'stopping…')
  ptyMgr.killPty(id)
}

/** Restart a session's process. Starts it if it isn't running. Some kinds have none. */
export function relaunchSession(win: BrowserWindow, id: string): void {
  const s = getSession(id)
  if (!s || isProcessless(s.kind)) return
  if (!s.alive) {
    resetTerminal(id)
    void startSession(win, id, ptyMgr.lastSizeOf(id))
    return
  }
  restartInPlace(win, id, 'relaunching…')
}
