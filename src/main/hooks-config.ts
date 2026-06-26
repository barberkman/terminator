import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { Session } from '../shared/types'
import { expandHome } from './pty-manager'
import { reportPort, reportToken, reporterPath } from './report-server'

// Events we attach our reporter to. All confirmed present in Claude Code 2.x.
const EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'Notification',
  'PermissionRequest',
  'Elicitation',
  'Stop',
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

function reporterCommand(kind: 'hook' | 'status'): string {
  const q = (s: string) => `"${s}"`
  return `${q(process.execPath)} ${q(reporterPath())} ${kind} ${reportPort()} ${reportToken()}`
}

function ourHooks(): Record<string, HookGroup[]> {
  const group: HookGroup = { hooks: [{ type: 'command', command: reporterCommand('hook') }] }
  const out: Record<string, HookGroup[]> = {}
  for (const ev of EVENTS) out[ev] = [group]
  return out
}

/**
 * `--settings` replaces the whole `hooks` key, so we read the user's + project's
 * own hooks and append ours, ensuring their hooks still fire during our sessions.
 */
function readUserHooks(projectPath: string): Record<string, HookGroup[]> {
  const files = [
    join(homedir(), '.claude', 'settings.json'),
    join(projectPath, '.claude', 'settings.json'),
    join(projectPath, '.claude', 'settings.local.json'),
  ]
  const merged: Record<string, HookGroup[]> = {}
  for (const f of files) {
    if (!existsSync(f)) continue
    try {
      const json = JSON.parse(readFileSync(f, 'utf8')) as { hooks?: Record<string, HookGroup[]> }
      if (json.hooks) {
        for (const [event, groups] of Object.entries(json.hooks)) {
          if (Array.isArray(groups)) merged[event] = [...(merged[event] ?? []), ...groups]
        }
      }
    } catch {
      // ignore malformed user settings
    }
  }
  return merged
}

/** Build the per-session settings file injected via `--settings`. Returns its path. */
export function buildSettingsFile(session: Session): string {
  const cwd = expandHome(session.worktreePath || session.projectPath) || session.projectPath
  const hooks = readUserHooks(cwd)
  for (const [event, groups] of Object.entries(ourHooks())) {
    hooks[event] = [...(hooks[event] ?? []), ...groups]
  }

  const settings = {
    hooks,
    statusLine: { type: 'command', command: reporterCommand('status'), padding: 0 },
  }

  const dir = join(app.getPath('userData'), 'sessions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${session.id}.settings.json`)
  writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8')
  return file
}
