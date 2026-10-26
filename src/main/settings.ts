import { app } from 'electron'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import {
  USAGE_REFRESH_DEFAULT,
  USAGE_REFRESH_MAX,
  USAGE_REFRESH_MIN,
  type EditorOption,
  type SessionRuntime,
  type Settings,
  type SyncStatus,
} from '../shared/types'
import {
  type PatchLeaf,
  type SettingsPatch,
  applyPatch,
  deepEqual,
  diffSettings,
  isLocalLeaf,
  isPlainObject,
  isSyncedJsonLeaf,
  leaves,
  osOverrideFile,
  pickLeaves,
} from '../shared/settings-sync'
import { isWsl, sameRuntime, validRuntime } from '../shared/wsl-path'
import { DEFAULT_THEME_ID } from '../shared/themes'
import { defaultShell } from './shell'
import {
  type SyncFiles,
  isInside,
  readJson,
  readText,
  resolveSyncFolder,
  samePath,
  setSyncDirs,
  syncFiles,
  writeAtomic,
  writeJson,
} from './sync-files'
import { carryThemes, loadCustomThemes, themesProblem } from './theme-store'

function defaultGitGui(): string {
  // The user's documented default on Windows is GitExtensions; elsewhere they set their own.
  if (process.platform === 'win32') return 'gitext'
  if (process.platform === 'darwin') return 'gitup'
  return 'git-gui'
}

function defaultProjectEditor(): EditorOption {
  // An app started from Finder or the Dock gets launchd's bare PATH, which doesn't
  // reach the `code` shim VS Code installs into /usr/local/bin — so on macOS the
  // app is named to `open` instead, which needs no PATH at all.
  if (process.platform === 'darwin') return { command: 'open', args: ['-a', 'Visual Studio Code'] }
  return { command: 'code', args: [] }
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
    projectEditor: defaultProjectEditor(),
    worktreesRoot: join(homedir(), 'terminator-worktrees'),
    projects: [],
    notifications: {
      command: '',
      triggerOn: ['waiting', 'error'],
      perType: {},
    },
    terminalFont: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    optionAsMeta: false,
    fontSize: 14,
    iconScale: 100,
    sidebarSide: 'left',
    theme: DEFAULT_THEME_ID,
    relaunchOnStartup: false,
    // Nothing listens for the `terminator` command until this is turned on.
    scripting: false,
    // Blank leaves a Claude session's environment alone, so Ctrl+G goes on opening
    // whatever $VISUAL/$EDITOR already named. Not validated beyond this: the only
    // read is an `=== IN_APP_EDITOR_ID`, so an unknown value is inert by itself.
    promptEditorId: '',
    globalToggleShortcut: 'F12',
    notesShortcut: 'CommandOrControl+Shift+N',
    quickOpenShortcut: 'CommandOrControl+P',
    editorPreviewTabs: true,
    notes: '',
    usageRefreshSeconds: USAGE_REFRESH_DEFAULT,
    attachments: { allowClaudeRead: true, keepDays: 7 },
    // No browser configured means the OS default opens links — the same thing
    // that happens today when you copy one out by hand, just without the copying.
    links: {
      enabled: true,
      // A plain click opening a link was too easy to do by accident — clicking into
      // a pane to focus it is all it takes. Ctrl/Cmd+click is the deliberate gesture.
      requireCtrlClick: true,
      browsers: [],
      defaultBrowserId: '',
      openFilePaths: true,
      // No editor configured keeps the original behaviour: a clicked path opens
      // in an in-app Editor pane for that project.
      editor: { command: '', args: [] },
      // Blank means "the editor above, if there is one" — so configuring a program
      // is still all it takes to send clicks there, and nobody who already did has
      // their clicks moved by this setting appearing.
      defaultEditorId: '',
    },
    // Empty = derive a Chrome-like UA from Electron's own. See browser.ts.
    browser: { userAgent: '' },
    // Linux-side counterparts of the Windows settings above, for WSL sessions. `~` is
    // expanded inside the distro. The blanks mean "same as the Windows setting".
    wsl: {
      worktreesRoot: '~/terminator-worktrees',
      gitGuiCommand: '',
      claudeCommand: '',
      claudeReadonlyCommand: '',
    },
    // Off: everything stays in this computer's settings.json, as it always has.
    syncFolder: '',
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * Bounded on the way through `merge`, which both the load and the save go past, so a
 * hand-edited settings.json can't leave a 0 — or a string — to become the footer's
 * `setInterval` period.
 */
function clampRefresh(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return USAGE_REFRESH_DEFAULT
  return Math.max(USAGE_REFRESH_MIN, Math.min(USAGE_REFRESH_MAX, Math.round(v)))
}

/** Deep-merge persisted settings over defaults so new fields always have a value. */
function merge(base: Settings, patch: SettingsPatch): Settings {
  return {
    ...applyPatch(base, patch),
    usageRefreshSeconds: clampRefresh(
      'usageRefreshSeconds' in patch ? patch.usageRefreshSeconds : base.usageRefreshSeconds,
    ),
  }
}

// ---- where each setting comes from ------------------------------------------
//
// With no sync folder, settings.json in userData is the whole story, read and
// written exactly as it always was. With one, the shared settings come from the
// folder — its settings.json, then this OS's override file — and the notes from its
// notes.md, while this computer's own settings stay here. settings.json here goes on
// holding everything, as a copy: turning sync off, or the folder going missing (not
// cloned yet, a network drive that's down), leaves this computer where it was.

/** userData/settings.json as it is on disk. A corrupt file reads as empty, as ever. */
function readLocal(): Record<string, unknown> {
  const r = readJson(settingsPath())
  return r.kind === 'ok' && isPlainObject(r.value) ? r.value : {}
}

interface Layers {
  local: Record<string, unknown>
  dir: string | null
  files: SyncFiles | null
  /** Null when the folder isn't usable, and this computer runs on its copy. */
  shared: Record<string, unknown> | null
  os: Record<string, unknown>
  notes: string
  /** Synced files that don't parse right now. Never written to. */
  broken: Set<string>
  status: SyncStatus
}

/**
 * The last version of each synced file that parsed, so a merge conflict holds the
 * values it had rather than dropping everything it set back to the defaults.
 */
const lastGood = new Map<string, Record<string, unknown>>()

function readSynced(path: string, broken: Set<string>): Record<string, unknown> | null {
  const r = readJson(path)
  if (r.kind === 'ok' && isPlainObject(r.value)) {
    lastGood.set(path, r.value)
    return r.value
  }
  if (r.kind === 'missing') {
    lastGood.delete(path)
    return null
  }
  broken.add(path)
  return lastGood.get(path) ?? null
}

function brokenMessage(names: string[]): string {
  const which = names.join(' and ')
  return `${which} in the sync folder ${names.length > 1 ? "aren't" : "isn't"} valid JSON — a merge conflict? Until ${names.length > 1 ? 'they parse' : 'it parses'}, Terminator keeps the last good version and won't write to ${names.length > 1 ? 'them' : 'it'}.`
}

/** Every file, read fresh. Also tells sync-files which folder is in use. */
function readLayers(): Layers {
  const local = readLocal()
  const dir = resolveSyncFolder(typeof local.syncFolder === 'string' ? local.syncFolder : '')
  const osFile = osOverrideFile(process.platform)
  const broken = new Set<string>()
  if (!dir) {
    setSyncDirs({ configured: null, active: null })
    const status = { dir: null, osFile, files: [], problem: '' }
    return { local, dir, files: null, shared: null, os: {}, notes: '', broken, status }
  }
  const files = syncFiles(dir)
  const shared = readSynced(files.settings, broken)
  const os = (files.os && readSynced(files.os, broken)) || {}
  const notes = readText(files.notes) ?? ''
  const present = [files.settings, files.os, files.themes, files.notes]
    .filter((f): f is string => !!f && existsSync(f))
    .map((f) => basename(f))
  let problem = ''
  if (broken.size) problem = brokenMessage([...broken].map((f) => basename(f)))
  else if (!shared) {
    problem = `There's no settings.json in ${dir}. Until there is, this computer runs on its last copy of the shared settings, and changes to them can't be saved.`
  }
  setSyncDirs({ configured: dir, active: shared ? dir : null })
  return { local, dir, files, shared, os, notes, broken, status: { dir, osFile, files: present, problem } }
}

/** Defaults, then this computer's settings, then the folder's — each only for the keys it owns. */
function compose(l: Layers): Settings {
  const base = defaultSettings()
  if (!l.shared) return merge(base, l.local as SettingsPatch)
  let s = merge(base, pickLeaves(l.local, isLocalLeaf))
  s = merge(s, pickLeaves(l.shared, isSyncedJsonLeaf))
  s = merge(s, pickLeaves(l.os, isSyncedJsonLeaf))
  return { ...s, notes: l.notes }
}

/** Today's format: the whole settings object, so the file is still the full list to edit. */
function writeLocal(next: Settings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeAtomic(settingsPath(), JSON.stringify(next, null, 2))
}

let cached: Settings | null = null
let status: SyncStatus = { dir: null, osFile: null, files: [], problem: '' }

export function loadSettings(): Settings {
  if (cached) return cached
  const l = readLayers()
  cached = compose(l)
  status = l.status
  // The copy here follows the folder, whoever changed it.
  if (l.shared && !deepEqual(l.local, cached)) {
    try {
      writeLocal(cached)
    } catch {
      // A copy: the next change tries again.
    }
  }
  return cached
}

/** Re-read everything — the sync folder changed on disk. True when the result moved. */
export function reloadSettings(): boolean {
  const before = cached
  cached = null
  return !before || !deepEqual(before, loadSettings())
}

export function syncStatus(): SyncStatus {
  loadSettings()
  loadCustomThemes()
  return { ...status, problem: status.problem || themesProblem() }
}

/**
 * Add a project to the recents list (deduped, capped) so it shows in New Session. A
 * project is its path *in* a runtime: `/home/me/api` in two distros is two projects.
 */
export function rememberProject(path: string, name?: string, runtime?: SessionRuntime): void {
  const s = loadSettings()
  if (s.projects.some((p) => p.path === path && sameRuntime(validRuntime(p.runtime), runtime))) return
  const projName = name?.trim() || path.split(/[/\\]/).filter(Boolean).pop() || path
  const entry = isWsl({ runtime }) ? { name: projName, path, runtime } : { name: projName, path }
  const projects = [entry, ...s.projects].slice(0, 12)
  saveSettings({ projects })
}

/** Whether a file already sets this leaf — an override stays an override. */
function sets(file: Record<string, unknown>, leaf: PatchLeaf): boolean {
  if (leaf.field === undefined) return leaf.key in file
  const section = file[leaf.key]
  return isPlainObject(section) && leaf.field in section
}

function setLeaf(file: Record<string, unknown>, leaf: PatchLeaf): void {
  if (leaf.field === undefined) {
    if (leaf.value === undefined) delete file[leaf.key]
    else file[leaf.key] = leaf.value
    return
  }
  const section = isPlainObject(file[leaf.key]) ? (file[leaf.key] as Record<string, unknown>) : {}
  if (leaf.value === undefined) delete section[leaf.field]
  else section[leaf.field] = leaf.value
  file[leaf.key] = section
}

/**
 * Write the shared leaves that changed into the folder, and only those: each file is
 * taken as it is on disk now, so whatever a pull put there that this save didn't
 * touch stays. Every target is checked before anything is written, so a save never
 * lands half-way.
 */
function writeSynced(l: Layers, changes: SettingsPatch): void {
  const shared = leaves(changes).filter((c) => !isLocalLeaf(c.key, c.field))
  if (!shared.length || !l.files) return
  if (!l.shared) throw new Error(l.status.problem)
  const files = l.files
  const json = new Map<string, Record<string, unknown>>()
  let notes: string | undefined
  for (const leaf of shared) {
    if (leaf.key === 'notes') {
      notes = typeof leaf.value === 'string' ? leaf.value : ''
      continue
    }
    const target = files.os && sets(l.os, leaf) ? files.os : files.settings
    if (l.broken.has(target)) throw new Error(brokenMessage([basename(target)]))
    if (!json.has(target)) json.set(target, structuredClone(target === files.os ? l.os : l.shared))
    setLeaf(json.get(target)!, leaf)
  }
  for (const [path, value] of json) writeJson(path, value)
  if (notes !== undefined) writeAtomic(files.notes, notes)
}

/** Atomic writes (temp + rename) so a crash mid-write can't corrupt a file. */
export function saveSettings(patch: SettingsPatch): Settings {
  const { syncFolder, ...rest } = patch
  if (typeof syncFolder === 'string') switchSyncFolder(syncFolder)
  const l = readLayers()
  const current = compose(l)
  const next = merge(current, rest)
  writeSynced(l, diffSettings(current, next))
  writeLocal(next)
  cached = null
  return loadSettings()
}

/** Keys a Terminator settings file can have — anything else is somebody else's file. */
function looksLikeOurs(file: Record<string, unknown>): boolean {
  const known = new Set([...Object.keys(defaultSettings()), 'customTheme', 'settingsOpen'])
  const keys = Object.keys(file)
  return keys.length === 0 || keys.some((k) => known.has(k))
}

/**
 * Point this computer at a sync folder, another one, or none. A folder that already
 * holds settings — a clone of the repo another computer filled — is adopted as it
 * is; an empty one is seeded from this computer, with the shared settings that differ
 * from the defaults, the notes and the themes. Either way your themes join the
 * folder's. Turning it off needs nothing: the copy here is already complete.
 */
function switchSyncFolder(raw: string): void {
  const l = readLayers()
  const current = compose(l)
  const to = resolveSyncFolder(raw)
  if (!to || (l.dir && samePath(to, l.dir))) {
    writeLocal({ ...current, syncFolder: to ? raw : '' })
    return
  }
  const userData = app.getPath('userData')
  if (isInside(to, userData)) {
    throw new Error(`The sync folder can't be inside Terminator's own data folder (${userData}).`)
  }
  const files = syncFiles(to)
  const theirs = readJson(files.settings)
  if (theirs.kind === 'broken' || (theirs.kind === 'ok' && !isPlainObject(theirs.value))) {
    throw new Error(`${files.settings} isn't valid JSON — a merge conflict? Fix it, then choose the folder again.`)
  }
  if (theirs.kind === 'ok' && !looksLikeOurs(theirs.value as Record<string, unknown>)) {
    throw new Error(`${files.settings} isn't a Terminator settings file. Choose a folder of its own for these settings.`)
  }
  mkdirSync(to, { recursive: true })
  // Kept once, from before the first switch: adopting a folder replaces this
  // computer's own preferences, and this is the one copy of them.
  const backup = join(userData, 'settings.before-sync.json')
  if (!existsSync(backup) && existsSync(settingsPath())) copyFileSync(settingsPath(), backup)
  if (theirs.kind === 'missing') {
    writeJson(files.settings, pickLeaves(diffSettings(defaultSettings(), current), isSyncedJsonLeaf))
  }
  if (current.notes && !existsSync(files.notes)) writeAtomic(files.notes, current.notes)
  carryThemes(files.themes)
  writeLocal({ ...current, syncFolder: raw })
}
