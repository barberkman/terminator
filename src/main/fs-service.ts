// Filesystem service for Editor sessions. All access is scoped to a session's
// project root (resolved in main from the session id — never trusted from the
// renderer). Directory watching drives the "pick up external changes" feature.
//
// Path identity: every path is resolved lexically (resolve + ~expansion, NO
// symlink resolution) so the strings the renderer builds by joining match the
// strings we emit. Symlink-escape is guarded separately with realpath.

import {
  existsSync,
  promises as fsp,
  realpathSync,
  statSync,
  watch,
  type Dirent,
  type FSWatcher,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { BrowserWindow } from 'electron'
import { Channels } from '../shared/channels'
import type { DirEntry, FileReadResult, FsChange } from '../shared/types'

/** Files larger than this are refused (returned as `tooLarge`, not read). */
const MAX_BYTES = 2 * 1024 * 1024
/** Trailing-debounce window for coalescing watcher events, per path. */
const DEBOUNCE_MS = 120
/** How long a self-write suppresses its own watcher echo. */
const SELF_WRITE_MS = 800
/** Our atomic-write temp suffix — skipped in tree/file change detection. */
const TMP_RE = /\.\d+\.tmp$/

let mainWindow: BrowserWindow | null = null

export function setWindow(w: BrowserWindow): void {
  mainWindow = w
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/** Absolute, ~-expanded, lexically-normalized (symlinks NOT resolved). */
function toAbs(p: string): string {
  return resolve(expandHome(p))
}

/**
 * Resolve `target` against the session root and confirm containment.
 * Returns the absolute path, or null if it escapes the root. Lexical containment
 * is the identity check; a best-effort realpath check additionally blocks symlink
 * escapes. `root` is already absolute + ~-free (normalized at session creation).
 */
function safe(root: string, target: string): string | null {
  const absRoot = toAbs(root)
  const abs = resolve(absRoot, expandHome(target))
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return null
  try {
    const realRoot = realpathSync(absRoot)
    const realTarget = existsSync(abs)
      ? realpathSync(abs)
      : join(realpathSync(dirname(abs)), basename(abs))
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return null
  } catch {
    // realpath can fail on freshly-removed paths — the lexical check already passed.
  }
  return abs
}

// ---- read / list / write ---------------------------------------------------

export async function listDir(root: string, dir: string): Promise<DirEntry[]> {
  const abs = safe(root, dir)
  if (!abs) return []
  let ents: Dirent[]
  try {
    ents = await fsp.readdir(abs, { withFileTypes: true })
  } catch {
    return []
  }
  const out: DirEntry[] = ents.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
  return out
}

export async function readFile(root: string, path: string): Promise<FileReadResult> {
  const abs = safe(root, path)
  if (!abs) return { ok: false, reason: 'missing' }
  let st
  try {
    st = await fsp.stat(abs)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!st.isFile()) return { ok: false, reason: 'missing' }
  if (st.size > MAX_BYTES) return { ok: false, reason: 'tooLarge' }
  const buf = await fsp.readFile(abs)
  // Binary sniff: a NUL byte in the first 8 KB means "don't try to edit this".
  if (buf.subarray(0, 8192).includes(0)) return { ok: false, reason: 'binary' }
  return { ok: true, content: buf.toString('utf8') }
}

export async function writeFile(root: string, path: string, content: string): Promise<void> {
  const abs = safe(root, path)
  if (!abs) throw new Error('path is outside the project root')
  markSelfWrite(abs)
  // Atomic temp+rename (same pattern as settings/persistence) so a crash mid-write
  // never leaves a truncated file. Content is written verbatim — callers preserve
  // the file's existing EOL/final-newline so saves don't churn git diffs.
  const tmp = `${abs}.${process.pid}.tmp`
  await fsp.writeFile(tmp, content, 'utf8')
  await fsp.rename(tmp, abs)
}

// ---- self-write suppression ------------------------------------------------

const selfWrites = new Map<string, number>()

function markSelfWrite(abs: string): void {
  selfWrites.set(abs, Date.now() + SELF_WRITE_MS)
}

function isSelfWrite(abs: string): boolean {
  const exp = selfWrites.get(abs)
  if (exp == null) return false
  if (Date.now() > exp) {
    selfWrites.delete(abs)
    return false
  }
  return true
}

// ---- watching --------------------------------------------------------------
// One FSWatcher per physical directory (deduped, ref-counted by its interested
// targets). fs.watch is non-recursive on Linux, so a file is watched via its
// parent directory — this also catches atomic temp+rename replaces that swap the
// file's inode (a direct inode watch would go deaf).

interface DirWatch {
  watcher: FSWatcher | null
  /** basename -> renderer path id, for open files living in this dir. */
  fileIds: Map<string, string>
  /** Renderer path id of this dir when it's an expanded tree node. */
  treeId: string | null
}

interface SessionWatch {
  dirs: Map<string, DirWatch>
  timers: Map<string, NodeJS.Timeout>
}

const watches = new Map<string, SessionWatch>()

function emitChange(c: FsChange): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(Channels.fsChanged, c)
}

function schedule(sw: SessionWatch, key: string, fn: () => void): void {
  const prev = sw.timers.get(key)
  if (prev) clearTimeout(prev)
  sw.timers.set(
    key,
    setTimeout(() => {
      sw.timers.delete(key)
      fn()
    }, DEBOUNCE_MS),
  )
}

function onDirEvent(sessionId: string, absDir: string, filename: string | null): void {
  const sw = watches.get(sessionId)
  const dw = sw?.dirs.get(absDir)
  if (!sw || !dw) return

  const emitFile = (id: string) =>
    schedule(sw, id, () => {
      const abs = toAbs(id)
      if (isSelfWrite(abs)) return
      try {
        if (statSync(abs).isFile()) emitChange({ sessionId, path: id, kind: 'modified' })
      } catch {
        emitChange({ sessionId, path: id, kind: 'removed' })
      }
    })

  if (filename && !TMP_RE.test(filename)) {
    const id = dw.fileIds.get(filename)
    if (id) emitFile(id)
  } else if (!filename) {
    // Some platforms omit the filename — refresh every tracked file in this dir.
    for (const id of dw.fileIds.values()) emitFile(id)
  }

  // Any create/delete/rename inside an expanded dir → re-list just that dir.
  if (dw.treeId && !(filename && TMP_RE.test(filename))) {
    schedule(sw, `dir:${absDir}`, () => emitChange({ sessionId, path: dw.treeId!, kind: 'dir' }))
  }
}

function ensureDir(sessionId: string, sw: SessionWatch, absDir: string): DirWatch {
  let dw = sw.dirs.get(absDir)
  if (dw) return dw
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(absDir, { persistent: false }, (event, fn) =>
      onDirEvent(sessionId, absDir, fn ? fn.toString() : null),
    )
    watcher.on('error', () => {
      try {
        watcher?.close()
      } catch {
        // already gone
      }
    })
  } catch {
    watcher = null
  }
  dw = { watcher, fileIds: new Map(), treeId: null }
  sw.dirs.set(absDir, dw)
  return dw
}

function pruneDir(sw: SessionWatch, absDir: string): void {
  const dw = sw.dirs.get(absDir)
  if (!dw) return
  if (dw.treeId === null && dw.fileIds.size === 0) {
    try {
      dw.watcher?.close()
    } catch {
      // ignore
    }
    sw.dirs.delete(absDir)
  }
}

export function watchPath(sessionId: string, root: string, path: string): void {
  const abs = safe(root, path)
  if (!abs) return
  let isDir: boolean
  try {
    isDir = statSync(abs).isDirectory()
  } catch {
    return
  }
  let sw = watches.get(sessionId)
  if (!sw) {
    sw = { dirs: new Map(), timers: new Map() }
    watches.set(sessionId, sw)
  }
  if (isDir) {
    ensureDir(sessionId, sw, abs).treeId = path
  } else {
    ensureDir(sessionId, sw, dirname(abs)).fileIds.set(basename(abs), path)
  }
}

export function unwatchPath(sessionId: string, root: string, path: string): void {
  const sw = watches.get(sessionId)
  if (!sw) return
  const abs = safe(root, path)
  if (!abs) return
  const asTree = sw.dirs.get(abs)
  if (asTree && asTree.treeId === path) {
    asTree.treeId = null
    pruneDir(sw, abs)
  }
  const parent = dirname(abs)
  const asFile = sw.dirs.get(parent)
  if (asFile && asFile.fileIds.get(basename(abs)) === path) {
    asFile.fileIds.delete(basename(abs))
    pruneDir(sw, parent)
  }
}

export function closeAllForSession(sessionId: string): void {
  const sw = watches.get(sessionId)
  if (!sw) return
  for (const dw of sw.dirs.values()) {
    try {
      dw.watcher?.close()
    } catch {
      // ignore
    }
  }
  for (const t of sw.timers.values()) clearTimeout(t)
  watches.delete(sessionId)
}

export function closeAll(): void {
  for (const id of [...watches.keys()]) closeAllForSession(id)
}
