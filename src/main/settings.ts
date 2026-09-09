import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Settings } from '../shared/types'
import { DEFAULT_THEME_ID } from '../shared/themes'
import { defaultShell } from './shell'

function defaultGitGui(): string {
  // The user's documented default on Windows is GitExtensions; elsewhere they set their own.
  if (process.platform === 'win32') return 'gitext'
  if (process.platform === 'darwin') return 'gitup'
  return 'git-gui'
}

export function defaultSettings(): Settings {
  return {
    modes: {
      normal: { command: 'claude', extraArgs: [] },
      readonly: { command: 'claude-readonly', extraArgs: [] },
    },
    defaultShell: defaultShell(),
    shellArgs: [],
    gitGuiCommand: defaultGitGui(),
    worktreesRoot: join(homedir(), 'terminator-worktrees'),
    projects: [],
    notifications: {
      command: '',
      triggerOn: ['waiting', 'error'],
      perType: {},
    },
    terminalFont: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    fontSize: 14,
    iconScale: 100,
    sidebarSide: 'left',
    theme: DEFAULT_THEME_ID,
    globalToggleShortcut: 'F12',
    notesShortcut: 'CommandOrControl+Shift+N',
    notes: '',
    attachments: { allowClaudeRead: true, keepDays: 7 },
    // No browser configured means the OS default opens links — the same thing
    // that happens today when you copy one out by hand, just without the copying.
    links: { enabled: true, browsers: [], defaultBrowserId: '', openFilePaths: true },
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** Deep-merge persisted settings over defaults so new fields always have a value. */
function merge(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    modes: { ...base.modes, ...(patch.modes ?? {}) },
    notifications: { ...base.notifications, ...(patch.notifications ?? {}) },
    attachments: { ...base.attachments, ...(patch.attachments ?? {}) },
    // browsers[] is replaced wholesale (it's a list, not a set of fields), which
    // is what makes removing one in Settings actually remove it.
    links: { ...base.links, ...(patch.links ?? {}) },
    // Replaced wholesale rather than deep-merged, so deleting a token from
    // settings.json actually removes that override.
    customTheme: 'customTheme' in patch ? patch.customTheme : base.customTheme,
  }
}

let cached: Settings | null = null

export function loadSettings(): Settings {
  if (cached) return cached
  const path = settingsPath()
  let value = defaultSettings()
  if (existsSync(path)) {
    try {
      value = merge(value, JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>)
    } catch {
      // keep defaults on a corrupt file
    }
  }
  cached = value
  return value
}

/** Add a project to the recents list (deduped, capped) so it shows in New Session. */
export function rememberProject(path: string, name?: string): void {
  const s = loadSettings()
  if (s.projects.some((p) => p.path === path)) return
  const projName = name?.trim() || path.split(/[/\\]/).filter(Boolean).pop() || path
  const projects = [{ name: projName, path }, ...s.projects].slice(0, 12)
  saveSettings({ projects })
}

/** Atomic write (temp + rename) so a crash mid-write can't corrupt the file. */
export function saveSettings(patch: Partial<Settings>): Settings {
  const next = merge(loadSettings(), patch)
  cached = next
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const path = settingsPath()
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, path)
  return next
}
