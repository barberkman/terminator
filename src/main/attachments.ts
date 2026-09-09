// Getting an image or a file into a running session.
//
// A terminal can't take an attachment the way a chat window can, so what a paste
// or a drop actually does is *type a path* into the session — into Claude's
// prompt box (which then reads the file itself), or at a shell's prompt (which is
// what every other terminal does with a dropped file).
//
// Two rules shape the rest:
//   • Files already on disk are referenced where they lie — never copied, moved
//     or duplicated. Only things with no path of their own (a clipboard bitmap, a
//     file dragged out of a browser) get written out, and they land in an
//     app-owned folder under userData, never inside one of the user's repos.
//   • Nothing is inserted silently. Every call returns either the items that were
//     attached (with a thumbnail, when one can be made) or the reason it failed.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, clipboard, nativeImage } from 'electron'
import type { AttachFileInput, AttachResult, AttachedItem } from '../shared/types'
import * as ptyMgr from './pty-manager'
import { getSession } from './state'
import { loadSettings } from './settings'
import { quoteFor } from './shell'

/** Extensions Claude can look at as images (and that we can thumbnail). */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/** Ceilings for the attachments folder, enforced on every prune. */
const MAX_FILES = 200
const MAX_BYTES = 250 * 1024 * 1024
/** Don't try to decode a thumbnail for anything bigger than this. */
const THUMB_MAX_BYTES = 12 * 1024 * 1024
/** Cap on a pathless drop we have to materialise ourselves. */
const MAX_INLINE_BYTES = 25 * 1024 * 1024

/**
 * Where materialised attachments live: inside the app's own user-data directory,
 * so they can never be picked up by a `git status` in one of the user's projects.
 */
export function attachmentsDir(): string {
  const dir = join(app.getPath('userData'), 'attachments')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Keep the folder bounded: drop anything past the age limit, then trim the oldest
 * until it's back under the file-count and size ceilings. Only ever touches our
 * own directory — dropped files are elsewhere, untouched.
 */
export function pruneAttachments(): void {
  const dir = attachmentsDir()
  const keepDays = loadSettings().attachments.keepDays
  let files: { path: string; mtime: number; size: number }[] = []
  try {
    files = readdirSync(dir).map((name) => {
      const path = join(dir, name)
      const st = statSync(path)
      return { path, mtime: st.mtimeMs, size: st.size }
    })
  } catch {
    return
  }

  const cutoff = keepDays > 0 ? Date.now() - keepDays * 86_400_000 : 0
  const drop = (f: { path: string }) => {
    try {
      unlinkSync(f.path)
    } catch {
      // in use or already gone
    }
  }

  const kept: typeof files = []
  for (const f of files) {
    if (cutoff && f.mtime < cutoff) drop(f)
    else kept.push(f)
  }

  // Newest first, then walk down until both ceilings are satisfied.
  kept.sort((a, b) => b.mtime - a.mtime)
  let bytes = 0
  kept.forEach((f, i) => {
    bytes += f.size
    if (i >= MAX_FILES || bytes > MAX_BYTES) drop(f)
  })
}

function ext(p: string): string {
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i).toLowerCase()
}

/** `20260909-142530-8f3a` — sortable, unique, and readable in a prompt. */
function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const rand = Math.random().toString(16).slice(2, 6)
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`
}

/**
 * A small preview for the confirmation toast — a terminal can't show one, so the
 * app has to. Best-effort: anything that won't decode simply has no thumbnail.
 */
function thumbFor(path: string): string | undefined {
  if (!IMAGE_EXT.has(ext(path))) return undefined
  try {
    if (statSync(path).size > THUMB_MAX_BYTES) return undefined
    const img = nativeImage.createFromPath(path)
    if (img.isEmpty()) return undefined
    return img.resize({ height: 44, quality: 'good' }).toDataURL()
  } catch {
    return undefined
  }
}

function itemFor(path: string): AttachedItem {
  let isDir = false
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    // reported by the caller, which stats first
  }
  return {
    name: basename(path) || path,
    path,
    kind: isDir ? 'dir' : IMAGE_EXT.has(ext(path)) ? 'image' : 'file',
    thumb: isDir ? undefined : thumbFor(path),
  }
}

/** Write the clipboard bitmap out as a PNG. Null when the clipboard holds no image. */
function saveClipboardImage(): string | null {
  const img = clipboard.readImage()
  if (img.isEmpty()) return null
  const path = join(attachmentsDir(), `paste-${stamp()}.png`)
  writeFileSync(path, img.toPNG())
  return path
}

/** Write a dropped file that has no path of its own (e.g. dragged from a browser). */
function saveBytes(name: string, bytes: Uint8Array): string {
  const safe = (name || 'drop').replace(/[^\w.-]+/g, '_').slice(-60)
  const path = join(attachmentsDir(), `drop-${stamp()}-${safe}`)
  writeFileSync(path, bytes)
  return path
}

/**
 * How a path is written into a session.
 *
 * Claude gets it as a bracketed paste (ESC[200~ … ESC[201~) — the same mechanism
 * the branch prefill uses — so it lands in the prompt box as text at the cursor:
 * nothing already typed is lost, nothing is submitted. Paths with spaces are
 * quoted so Claude reads them as one path.
 *
 * A shell gets the plainly shell-quoted path with a trailing space, which is what
 * dropping a file on any other terminal does. No newline: it's never executed.
 */
function typeIntoSession(id: string, kind: 'claude' | 'shell', paths: string[]): void {
  if (kind === 'claude') {
    const text = paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')
    ptyMgr.writePty(id, `\x1b[200~${text} \x1b[201~`)
    return
  }
  const shell = loadSettings().defaultShell
  ptyMgr.writePty(id, `${paths.map((p) => quoteFor(shell, p)).join(' ')} `)
}

/** Shared preflight: the session has to exist, have a PTY, and be running. */
function target(id: string): { kind: 'claude' | 'shell' } | { error: string } {
  const s = getSession(id)
  if (!s) return { error: 'that session is gone' }
  if (s.kind === 'editor') {
    return { error: 'an editor pane has no session to attach to — use a Claude or terminal pane' }
  }
  if (!s.alive) return { error: `${s.name} isn't running — relaunch it first` }
  return { kind: s.kind }
}

/**
 * Ctrl/Cmd+V with a bitmap on the clipboard: write it out as a PNG and reference
 * it. The renderer only routes here when the clipboard actually holds an image,
 * so an empty read means it changed underneath us.
 */
export function attachClipboardImage(id: string): AttachResult {
  const t = target(id)
  if ('error' in t) return { ok: false, reason: t.error }

  let path: string | null
  try {
    path = saveClipboardImage()
  } catch (e) {
    return { ok: false, reason: `couldn't save the clipboard image: ${String(e).slice(0, 120)}` }
  }
  if (!path) return { ok: false, reason: 'the clipboard no longer holds an image' }

  typeIntoSession(id, t.kind, [path])
  pruneAttachments()
  return {
    ok: true,
    items: [itemFor(path)],
    note: t.kind === 'shell' ? 'saved and typed at the prompt' : undefined,
  }
}

/**
 * A drop. Files on disk are referenced in place; a file with no path is written
 * to the attachments folder first. Either every file resolves or nothing is
 * typed, so a partly-failed drop can't leave half a reference in the prompt.
 */
export function attachFiles(id: string, files: AttachFileInput[]): AttachResult {
  const t = target(id)
  if ('error' in t) return { ok: false, reason: t.error }
  if (!files.length) return { ok: false, reason: 'nothing to attach — the drop carried no files' }

  const paths: string[] = []
  for (const f of files) {
    if (f.path) {
      if (!existsSync(f.path)) return { ok: false, reason: `${basename(f.path)} no longer exists` }
      paths.push(f.path)
      continue
    }
    // No path: it only exists as bytes (dragged out of a browser, say), so it has
    // to be written out before anything can read it.
    if (!f.bytes?.length) {
      return {
        ok: false,
        reason: `${f.name || 'that item'} isn't a file on disk — only files can be attached`,
      }
    }
    if (f.bytes.length > MAX_INLINE_BYTES) {
      return { ok: false, reason: `${f.name || 'that item'} is too large to copy in (25 MB limit)` }
    }
    try {
      paths.push(saveBytes(f.name || 'drop', f.bytes))
    } catch (e) {
      return { ok: false, reason: `couldn't save ${f.name || 'the drop'}: ${String(e).slice(0, 120)}` }
    }
  }

  const items = paths.map(itemFor)
  typeIntoSession(id, t.kind, paths)
  pruneAttachments()
  const dirs = items.filter((i) => i.kind === 'dir').length
  return {
    ok: true,
    items,
    note: dirs ? 'folders are referenced as paths, not expanded' : undefined,
  }
}
