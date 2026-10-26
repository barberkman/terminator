import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { deepEqual } from '../shared/settings-sync'
import { type CustomTheme, sanitizeSeed } from '../shared/themes'
import type { ThemeOp } from '../shared/types'
import { activeSyncDir, readJson, syncFiles, writeAtomic, writeJson } from './sync-files'

// The user's own themes, deliberately kept out of settings.json: a theme is some
// seventy colours and settings.json is a file people edit by hand. Same shape as
// persistence.ts — one cached copy, a tolerant read, an atomic write. With a sync
// folder in use they live there, and the file here is kept as a copy, the same
// bargain settings.json makes.

/** Plenty for anyone, and a ceiling a runaway import can't grow the file past. */
const MAX_THEMES = 64

function localFile(): string {
  return join(app.getPath('userData'), 'themes.json')
}

function file(): string {
  const dir = activeSyncDir()
  return dir ? syncFiles(dir).themes : localFile()
}

/** First id wins, and the list is capped. */
function dedupe(list: CustomTheme[]): CustomTheme[] {
  const seen = new Set<string>()
  const out: CustomTheme[] = []
  for (const seed of list) {
    if (seen.has(seed.id)) continue
    seen.add(seed.id)
    out.push(seed)
    if (out.length >= MAX_THEMES) break
  }
  return out
}

function clean(list: unknown[]): CustomTheme[] {
  return dedupe(list.map((entry) => sanitizeSeed(entry)).filter((s): s is CustomTheme => s !== null))
}

/**
 * The file's themes; null when it's there but doesn't parse. Every entry is
 * re-validated on the way in, so a file somebody hand-edited into nonsense costs the
 * themes it broke and nothing else.
 */
function read(path: string): CustomTheme[] | null {
  const r = readJson(path)
  if (r.kind === 'missing') return []
  if (r.kind === 'ok' && Array.isArray(r.value)) return clean(r.value)
  return null
}

/** Best effort, same as the session list. */
function writeLocalCopy(list: CustomTheme[]): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeAtomic(localFile(), JSON.stringify(list, null, 2))
  } catch {
    // the next change tries again
  }
}

/** Keyed by path, so pointing settings at another folder is a fresh read. */
let cached: { path: string; list: CustomTheme[] } | null = null
/** The last synced list that parsed — what a merge conflict leaves on screen. */
const lastGood = new Map<string, CustomTheme[]>()
let problem = ''

export function loadCustomThemes(): CustomTheme[] {
  const path = file()
  if (cached?.path === path) return cached.list
  const dir = activeSyncDir()
  const got = read(path)
  problem = ''
  let list: CustomTheme[]
  if (got) {
    list = got
    if (dir) {
      lastGood.set(path, got)
      if (!deepEqual(read(localFile()), got)) writeLocalCopy(got)
    }
  } else if (dir) {
    problem = "themes.json in the sync folder isn't valid JSON — a merge conflict? Until it parses, Terminator keeps the last good version and won't write to it."
    list = lastGood.get(path) ?? read(localFile()) ?? []
  } else {
    // A corrupt file costs the custom themes, never the app.
    list = []
  }
  cached = { path, list }
  return list
}

/** Why the synced themes are held where they are. Empty = fine. */
export function themesProblem(): string {
  return problem
}

/** Re-read — the sync folder changed on disk. True when the list moved. */
export function reloadCustomThemes(): boolean {
  const before = cached?.list
  cached = null
  return !before || !deepEqual(before, loadCustomThemes())
}

/**
 * One theme added, replaced or deleted — the renderer owns create/duplicate/rename/
 * delete, the same way it owns `projects` and `links.browsers`. Applied to the file
 * as it is on disk now rather than to a list the window sent, so a theme a pull
 * just brought in isn't dropped because the window hadn't seen it yet. The payload
 * is input like any other, so it goes through the sanitiser again on this side.
 */
export function updateCustomThemes(op: ThemeOp): CustomTheme[] {
  const o = (op ?? {}) as { upsert?: unknown; remove?: unknown }
  const dir = activeSyncDir()
  const path = file()
  const disk = read(path)
  if (!disk && dir) {
    throw new Error("themes.json in the sync folder isn't valid JSON — a merge conflict? Fix it, and theme changes will save again.")
  }
  let list = disk ?? []
  if (o.upsert !== undefined) {
    const seed = sanitizeSeed(o.upsert)
    if (!seed) return loadCustomThemes()
    const at = list.findIndex((t) => t.id === seed.id)
    list = at < 0 ? [...list, seed] : list.map((t, i) => (i === at ? seed : t))
  } else if (typeof o.remove === 'string') {
    list = list.filter((t) => t.id !== o.remove)
  } else return loadCustomThemes()
  const next = dedupe(list)
  // The folder's copy is the one that counts, so a failure there is reported.
  if (dir) writeJson(path, next)
  cached = { path, list: next }
  writeLocalCopy(next)
  return next
}

/**
 * Turning sync on: this computer's themes join whatever the folder already holds.
 * The folder wins on the same id; a folder whose themes.json doesn't parse is left
 * for the user to fix, and says so.
 */
export function carryThemes(dest: string): void {
  const mine = loadCustomThemes()
  const theirs = read(dest)
  if (!theirs) return
  const ids = new Set(theirs.map((t) => t.id))
  const extra = mine.filter((t) => !ids.has(t.id))
  if (extra.length) writeJson(dest, dedupe([...theirs, ...extra]))
}
