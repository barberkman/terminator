import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { Session } from '../shared/types'
import { isWsl, linuxToHost, sessionFolder } from '../shared/wsl-path'
import { attachmentsDir } from './attachments'
import { expandHome } from './pty-manager'
import { reportPort, reportToken, reporterPath } from './report-server'
import { loadSettings } from './settings'
import { shquote } from './shell'
import { winToLinux, type Probe } from './wsl'

// Events we attach our reporter to. Names verified against the installed Claude Code
// (2.1.267): every one of these is in the CLI's own hook-event list. `StopFailure` is
// the separate failure counterpart to `Stop` — leaving it out is what made the app's
// error branch unreachable — and the Subagent pair is what keeps a session's activity
// honest while a Task call runs.
const EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'Notification',
  'PermissionRequest',
  'Elicitation',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'SessionStart',
  'SessionEnd',
]

interface HookCommand {
  type: 'command'
  command: string
}
interface HookGroup {
  matcher?: string
  hooks: HookCommand[]
}

/** The subset of Claude's `permissions` block we read back and re-state. */
interface Permissions {
  allow?: string[]
  deny?: string[]
  ask?: string[]
  additionalDirectories?: string[]
  defaultMode?: string
}

/**
 * The settings files Claude would read on its own, in ascending precedence, as this
 * process reaches them. A WSL session's Claude is a Linux program with a Linux home:
 * its user settings are the distro's, and the Windows ones — whose hooks would be
 * PowerShell and .exe commands — are none of its business.
 */
function userSettingsFiles(projectPath: string, wsl?: Probe): string[] {
  if (wsl) {
    const host = (linux: string) => linuxToHost(wsl.distro, linux)
    return [
      host(`${wsl.claudeDir}/settings.json`),
      host(`${projectPath}/.claude/settings.json`),
      host(`${projectPath}/.claude/settings.local.json`),
    ]
  }
  return [
    join(homedir(), '.claude', 'settings.json'),
    join(projectPath, '.claude', 'settings.json'),
    join(projectPath, '.claude', 'settings.local.json'),
  ]
}

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null // ignore malformed user settings
  }
}

function reporterCommand(kind: 'hook' | 'status', wsl?: Probe): string {
  if (wsl) return wslReporterCommand(kind, wsl)
  const q = (s: string) => `"${s}"`
  return `${q(process.execPath)} ${q(reporterPath())} ${kind} ${reportPort()} ${reportToken()}`
}

/**
 * The same reporter, run from inside WSL. It still runs on the *Windows* side, through
 * interop, because that is the only side that can reach the report server: it listens
 * on Windows' 127.0.0.1, which a WSL2 distro in its default (NAT) networking can't
 * see. Running it this way needs no firewall rule and no change to how WSL is set up.
 *
 *   • `ELECTRON_RUN_AS_NODE` is set inline, and handed across by `WSLENV`, rather
 *     than trusted to be in the environment: without it the executable is the whole
 *     app, and every hook would open another window.
 *   • The executable is named by its Linux path (Linux has to find it), but the script
 *     by its Windows one — interop passes arguments through untranslated, and the
 *     program reading them is a Windows one.
 *   • The timestamp is taken by Linux as the hook fires. Starting a Windows process
 *     from WSL takes long enough (~100 ms) that stamping it on arrival would blur the
 *     order of hooks fired close together — the order report-server.ts relies on.
 */
function wslReporterCommand(kind: 'hook' | 'status', wsl: Probe): string {
  return [
    'ELECTRON_RUN_AS_NODE=1',
    'WSLENV=ELECTRON_RUN_AS_NODE',
    shquote(wsl.exeLinux),
    shquote(reporterPath()),
    kind,
    String(reportPort()),
    reportToken(),
    '"$(date +%s%3N)"',
  ].join(' ')
}

function ourHooks(wsl?: Probe): Record<string, HookGroup[]> {
  const group: HookGroup = { hooks: [{ type: 'command', command: reporterCommand('hook', wsl) }] }
  const out: Record<string, HookGroup[]> = {}
  for (const ev of EVENTS) out[ev] = [group]
  return out
}

/**
 * `--settings` replaces the whole `hooks` key, so we read the user's + project's
 * own hooks and append ours, ensuring their hooks still fire during our sessions.
 */
function readUserHooks(projectPath: string, wsl?: Probe): Record<string, HookGroup[]> {
  const merged: Record<string, HookGroup[]> = {}
  for (const f of userSettingsFiles(projectPath, wsl)) {
    const json = readJson(f) as { hooks?: Record<string, HookGroup[]> } | null
    if (!json?.hooks) continue
    for (const [event, groups] of Object.entries(json.hooks)) {
      if (Array.isArray(groups)) merged[event] = [...(merged[event] ?? []), ...groups]
    }
  }
  return merged
}

/**
 * Same story as the hooks, for the same reason: a `permissions` key in our
 * `--settings` file could otherwise stand in for the user's own rules, so read
 * theirs first and add ours on top.
 *
 * Ours is one entry — the attachments folder — in `additionalDirectories`, which
 * is what makes a pasted screenshot readable without a permission prompt. It
 * covers only that app-owned folder; dropped files are read from wherever they
 * live and are governed by the user's normal rules.
 */
function buildPermissions(projectPath: string, wsl?: Probe): Permissions {
  const merged: Permissions = {}
  const listKeys = ['allow', 'deny', 'ask', 'additionalDirectories'] as const
  for (const f of userSettingsFiles(projectPath, wsl)) {
    const perms = readJson(f)?.permissions as Permissions | undefined
    if (!perms) continue
    for (const k of listKeys) {
      if (Array.isArray(perms[k])) merged[k] = [...(merged[k] ?? []), ...perms[k]]
    }
    if (typeof perms.defaultMode === 'string') merged.defaultMode = perms.defaultMode
  }
  if (loadSettings().attachments.allowClaudeRead) {
    // A WSL session reads the folder through the distro's Windows-drive mount.
    const dir = wsl ? winToLinux(wsl, attachmentsDir()) : attachmentsDir()
    if (dir && !merged.additionalDirectories?.includes(dir)) {
      merged.additionalDirectories = [...(merged.additionalDirectories ?? []), dir]
    }
  }
  return merged
}

/**
 * Build the per-session settings file injected via `--settings`. Returns its path —
 * on this machine, so a WSL session's launcher turns it into the distro's name for it.
 * `wsl` is the distro's probe, and is required for a WSL session.
 */
export function buildSettingsFile(session: Session, wsl?: Probe): string {
  if (isWsl(session) && !wsl) throw new Error('a WSL session needs its distro probed first')
  const cwd = wsl
    ? sessionFolder(session)
    : expandHome(session.worktreePath || session.projectPath) || session.projectPath
  const hooks = readUserHooks(cwd, wsl)
  for (const [event, groups] of Object.entries(ourHooks(wsl))) {
    hooks[event] = [...(hooks[event] ?? []), ...groups]
  }

  const settings = {
    hooks,
    permissions: buildPermissions(cwd, wsl),
    statusLine: { type: 'command', command: reporterCommand('status', wsl), padding: 0 },
  }

  const dir = join(app.getPath('userData'), 'sessions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${session.id}.settings.json`)
  writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8')
  return file
}
