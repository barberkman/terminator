import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { SYNC_NOTES_FILE, SYNC_SETTINGS_FILE, SYNC_THEMES_FILE, osOverrideFile } from '../shared/settings-sync'

// Where the synced settings folder is, and reading and writing its files without
// ever leaving one half-written. Kept apart from settings.ts so the theme store can
// find the folder without the two importing each other: settings.ts decides which
// folder is in use, this module holds the answer.

/** Set in Settings, resolved. Null when syncing is off. */
let configured: string | null = null
/** The same folder, but only while it's usable — it holds a settings.json that parses. */
let active: string | null = null

export function setSyncDirs(next: { configured: string | null; active: string | null }): void {
  configured = next.configured
  active = next.active
}

/** The folder the watcher keeps an eye on — even one that isn't there yet. */
export function configuredSyncDir(): string | null {
  return configured
}

/** The folder shared settings and themes are read from and written to, if any. */
export function activeSyncDir(): string | null {
  return active
}

export interface SyncFiles {
  settings: string
  /** This OS's overrides. Null on a platform without one. */
  os: string | null
  themes: string
  notes: string
}

export function syncFiles(dir: string): SyncFiles {
  const os = osOverrideFile(process.platform)
  return {
    settings: join(dir, SYNC_SETTINGS_FILE),
    os: os ? join(dir, os) : null,
    themes: join(dir, SYNC_THEMES_FILE),
    notes: join(dir, SYNC_NOTES_FILE),
  }
}

/**
 * `~/dotfiles/terminator`, `~\Sync\terminator`, `C:\Users\me\settings`, or a bare
 * `terminator-settings` (from the home folder). Empty means off.
 */
export function resolveSyncFolder(raw: string | undefined): string | null {
  const t = (raw ?? '').trim()
  if (!t) return null
  const home = homedir()
  const expanded = t === '~' ? home : /^~[\\/]/.test(t) ? join(home, t.slice(2)) : t
  return resolve(home, expanded)
}

/** Windows and macOS file systems ignore case, so `C:\X` and `c:\x\` are one folder. */
function comparable(p: string): string {
  let out = resolve(p)
  try {
    out = realpathSync.native(out)
  } catch {
    // not there (yet): compare the path as written
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? out.toLowerCase() : out
}

export function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b)
}

export function isInside(child: string, parent: string): boolean {
  const r = relative(comparable(parent), comparable(child))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

export type JsonRead = { kind: 'ok'; value: unknown } | { kind: 'missing' } | { kind: 'broken' }

/** PowerShell's `-Encoding utf8` writes a byte-order mark, which JSON.parse refuses. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function readJson(path: string): JsonRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { kind: 'missing' }
  }
  try {
    return { kind: 'ok', value: JSON.parse(stripBom(text)) }
  } catch {
    return { kind: 'broken' }
  }
}

/** Null when there's no file. Line endings come back as `\n` whatever git checked out. */
export function readText(path: string): string | null {
  try {
    return stripBom(readFileSync(path, 'utf8')).replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

/** Blocks the main process — only ever for the few ms a retry below needs. */
function pause(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    for (const end = Date.now() + ms; Date.now() < end; );
  }
}

// What Windows says while a virus scanner, the search indexer or a sync client has
// the file open for a moment.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Temp file + rename, so a crash mid-write can't leave a torn file — and a reader
 * never sees one. A symlinked file (a dotfiles manager's) is written through: the
 * temp file goes next to the real one, so the link survives.
 */
export function writeAtomic(path: string, text: string): void {
  let target = path
  try {
    target = realpathSync(path)
  } catch {
    // a new file
  }
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, target)
      return
    } catch (e) {
      if (attempt >= 9 || !BUSY.has((e as NodeJS.ErrnoException).code ?? '')) {
        try {
          unlinkSync(tmp)
        } catch {
          // already gone
        }
        throw e
      }
      pause(50)
    }
  }
}

/** Two-space JSON with a final newline — the shape a hand-edited, diffed file has. */
export function writeJson(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}
