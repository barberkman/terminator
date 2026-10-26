import type { Settings } from './types'

// Which settings travel with a synced settings folder and which stay on this
// computer, plus the patch arithmetic both sides of the app use to move only what
// changed. Pure on purpose: main routes saves with it, and the Settings panel uses
// the same diff to post only the fields you touched.

/**
 * The sections `merge` combines field by field. A change inside one is a change to
 * that one field, which is what lets a synced folder hold `links.requireCtrlClick`
 * while `links.browsers` stays on this machine.
 */
export const SECTIONS = [
  'modes', 'projectEditor', 'notifications', 'attachments', 'links', 'browser', 'wsl',
] as const satisfies readonly (keyof Settings)[]

export type SettingsSection = (typeof SECTIONS)[number]

/** A partial settings object whose sections are partial too — what a save carries. */
export type SettingsPatch = {
  [K in keyof Settings]?: K extends SettingsSection ? Partial<Settings[K]> : Settings[K]
}

/** A top-level key, or `section.field`. */
type Leaf =
  | keyof Settings
  | { [K in SettingsSection]: `${K}.${keyof Settings[K] & string}` }[SettingsSection]

/**
 * What stays on this computer when a sync folder is set. Everything else is shared.
 * The rule: a setting stays local when it names a program or a path on this
 * machine, lists this machine's projects or distros, or is UI state that would only
 * churn commits. `scripting` stays too — a pull must never open a control channel on
 * another computer — and `links.defaultBrowserId`, which points into the local list.
 */
export const LOCAL_SETTINGS = [
  'syncFolder',
  'defaultShell',
  'shellArgs',
  'gitGuiCommand',
  'projectEditor',
  'worktreesRoot',
  'projects',
  'scripting',
  'settingsOpen',
  'wsl',
  'notifications.command',
  'notifications.perType',
  'links.browsers',
  'links.defaultBrowserId',
  'links.editor',
] as const satisfies readonly Leaf[]

const LOCAL = new Set<string>(LOCAL_SETTINGS)

export function isLocalLeaf(key: string, field?: string): boolean {
  return LOCAL.has(key) || (field !== undefined && LOCAL.has(`${key}.${field}`))
}

/** Shared, and kept in `settings.json` — the notes have a file of their own. */
export function isSyncedJsonLeaf(key: string, field?: string): boolean {
  return key !== 'notes' && !isLocalLeaf(key, field)
}

/** The files a sync folder holds. Nothing else is ever written there. */
export const SYNC_SETTINGS_FILE = 'settings.json'
export const SYNC_THEMES_FILE = 'themes.json'
export const SYNC_NOTES_FILE = 'notes.md'

/** The per-OS override file this platform reads from the sync folder. */
export function osOverrideFile(platform: string): string | null {
  if (platform === 'win32') return 'settings.windows.json'
  if (platform === 'darwin') return 'settings.macos.json'
  if (platform === 'linux') return 'settings.linux.json'
  return null
}

function isSection(key: string): key is SettingsSection {
  return (SECTIONS as readonly string[]).includes(key)
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Key order doesn't count: a file round trip is free to reorder. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (!deepEqual(a[k], b[k])) return false
  return true
}

/** One change: a top-level key, or one field of a section. */
export interface PatchLeaf {
  key: string
  field?: string
  value: unknown
}

/** Every leaf a patch sets. A section that isn't an object counts as one leaf. */
export function leaves(patch: object): PatchLeaf[] {
  const out: PatchLeaf[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (isSection(key) && isPlainObject(value)) {
      for (const [field, v] of Object.entries(value)) out.push({ key, field, value: v })
    } else out.push({ key, value })
  }
  return out
}

/** The part of a patch whose leaves pass `keep`. */
export function pickLeaves(patch: object, keep: (key: string, field?: string) => boolean): SettingsPatch {
  const out: Record<string, unknown> = {}
  for (const { key, field, value } of leaves(patch)) {
    if (!keep(key, field)) continue
    if (field === undefined) out[key] = value
    else out[key] = { ...(out[key] as object | undefined), [field]: value }
  }
  return out as SettingsPatch
}

const obj = (v: unknown): Record<string, unknown> => (isPlainObject(v) ? v : {})

/**
 * Lay a patch over settings. Sections merge field by field, so a patch that names
 * one field keeps the rest. `modes` goes one level further: an override holding just
 * `modes.normal.command` keeps `extraArgs`, which a session launch reads.
 *
 * Lists (`links.browsers`, `projects`) are replaced wholesale — they are a list, not
 * a set of fields, which is what makes removing an entry actually remove it — and so
 * is `customTheme`, so deleting a token from the file really drops that override.
 */
export function applyPatch(base: Settings, patch: SettingsPatch): Settings {
  const sec = <K extends SettingsSection>(k: K): Settings[K] => ({ ...base[k], ...obj(patch[k]) }) as Settings[K]
  const modes = obj(patch.modes)
  return {
    ...base,
    ...(patch as Partial<Settings>),
    modes: {
      normal: { ...base.modes.normal, ...obj(modes.normal) },
      readonly: { ...base.modes.readonly, ...obj(modes.readonly) },
    },
    projectEditor: sec('projectEditor'),
    notifications: sec('notifications'),
    attachments: sec('attachments'),
    links: sec('links'),
    browser: sec('browser'),
    wsl: sec('wsl'),
  }
}

/**
 * The leaves that differ between two settings objects, as a patch — sections carry
 * only their changed fields. A key that went away is kept, as `undefined`, so the
 * patch can say "remove this".
 */
export function diffSettings(before: Settings, after: Settings): SettingsPatch {
  const a = before as unknown as Record<string, unknown>
  const b = after as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key]
    const y = b[key]
    if (isSection(key) && isPlainObject(x) && isPlainObject(y)) {
      const part: Record<string, unknown> = {}
      for (const field of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (!deepEqual(x[field], y[field])) part[field] = y[field]
      }
      if (Object.keys(part).length) out[key] = part
    } else if (!deepEqual(x, y)) out[key] = y
  }
  return out as SettingsPatch
}
