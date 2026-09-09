import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { Session } from '../shared/types'
import { attachmentsDir } from './attachments'
import { expandHome } from './pty-manager'
import { reportPort, reportToken, reporterPath } from './report-server'
import { loadSettings } from './settings'

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

/** The subset of Claude's `permissions` block we read back and re-state. */
interface Permissions {
  allow?: string[]
  deny?: string[]
  ask?: string[]
  additionalDirectories?: string[]
  defaultMode?: string
}

/** The settings files Claude would read on its own, in ascending precedence. */
function userSettingsFiles(projectPath: string): string[] {
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
  const merged: Record<string, HookGroup[]> = {}
  for (const f of userSettingsFiles(projectPath)) {
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
function buildPermissions(projectPath: string): Permissions {
  const merged: Permissions = {}
  const listKeys = ['allow', 'deny', 'ask', 'additionalDirectories'] as const
  for (const f of userSettingsFiles(projectPath)) {
    const perms = readJson(f)?.permissions as Permissions | undefined
    if (!perms) continue
    for (const k of listKeys) {
      if (Array.isArray(perms[k])) merged[k] = [...(merged[k] ?? []), ...perms[k]]
    }
    if (typeof perms.defaultMode === 'string') merged.defaultMode = perms.defaultMode
  }
  if (loadSettings().attachments.allowClaudeRead) {
    const dir = attachmentsDir()
    if (!merged.additionalDirectories?.includes(dir)) {
      merged.additionalDirectories = [...(merged.additionalDirectories ?? []), dir]
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
    permissions: buildPermissions(cwd),
    statusLine: { type: 'command', command: reporterCommand('status'), padding: 0 },
  }

  const dir = join(app.getPath('userData'), 'sessions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${session.id}.settings.json`)
  writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8')
  return file
}
