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
//
// Attachments are also *openable* afterwards, from the toast that announced them —
// see `openAttachment` at the bottom of this file for the rule that makes a path
// from the renderer safe to act on.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, clipboard, nativeImage, shell } from 'electron'
import type {
  AttachDeliver,
  AttachFileInput,
  AttachOpenResult,
  AttachResult,
  AttachedItem,
} from '../shared/types'
import { quotePaths } from '../shared/prompt-path'
import * as ptyMgr from './pty-manager'
import { getSession } from './state'
import { loadSettings } from './settings'
import { quoteFor } from './shell'
import { editorArgv, editorName, launchDetached } from './links'

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
    ptyMgr.writePty(id, `\x1b[200~${quotePaths(paths)} \x1b[201~`)
    return
  }
  const shell = loadSettings().defaultShell
  ptyMgr.writePty(id, `${paths.map((p) => quoteFor(shell, p)).join(' ')} `)
}

/**
 * Shared preflight: the session has to exist and be able to take an attachment.
 *
 * A running PTY is only needed to *type* into. When the caller is going to hold
 * the paths itself — the conversation view's composer, which shows them as chips
 * and sends them with the next message — a stopped session is fine: you can
 * attach a screenshot, write the message, and relaunch before sending. Requiring
 * `alive` there would refuse a perfectly sensible thing to do.
 */
function target(
  id: string,
  deliver: AttachDeliver,
): { kind: 'claude' | 'shell' } | { error: string } {
  const s = getSession(id)
  if (!s) return { error: 'that session is gone' }
  if (s.kind === 'editor') {
    return { error: 'an editor pane has no session to attach to — use a Claude or terminal pane' }
  }
  if (deliver === 'pty' && !s.alive) {
    return { error: `${s.name} isn't running — relaunch it first` }
  }
  // Caller delivery exists for the conversation view's composer, and only a Claude
  // session has one. Minting an openable path for a surface that can't show it
  // would be a quiet success that achieves nothing.
  if (deliver === 'caller' && s.kind !== 'claude') {
    return { error: 'only a Claude session can hold an attachment for its next message' }
  }
  return { kind: s.kind }
}

/**
 * Ctrl/Cmd+V with a bitmap on the clipboard: write it out as a PNG and reference
 * it. The renderer only routes here when the clipboard actually holds an image,
 * so an empty read means it changed underneath us.
 */
export function attachClipboardImage(id: string, deliver: AttachDeliver = 'pty'): AttachResult {
  const t = target(id, deliver)
  if ('error' in t) return { ok: false, reason: t.error }

  let path: string | null
  try {
    path = saveClipboardImage()
  } catch (e) {
    return { ok: false, reason: `couldn't save the clipboard image: ${String(e).slice(0, 120)}` }
  }
  if (!path) return { ok: false, reason: 'the clipboard no longer holds an image' }

  if (deliver === 'pty') typeIntoSession(id, t.kind, [path])
  pruneAttachments()
  const items = [itemFor(path)]
  remember(items)
  return {
    ok: true,
    items,
    note: deliver === 'pty' && t.kind === 'shell' ? 'saved and typed at the prompt' : undefined,
  }
}

/**
 * A drop. Files on disk are referenced in place; a file with no path is written
 * to the attachments folder first. Either every file resolves or nothing is
 * typed, so a partly-failed drop can't leave half a reference in the prompt.
 */
export function attachFiles(
  id: string,
  files: AttachFileInput[],
  deliver: AttachDeliver = 'pty',
): AttachResult {
  const t = target(id, deliver)
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
  remember(items)
  if (deliver === 'pty') typeIntoSession(id, t.kind, paths)
  pruneAttachments()
  const dirs = items.filter((i) => i.kind === 'dir').length
  return {
    ok: true,
    items,
    note: dirs ? 'folders are referenced as paths, not expanded' : undefined,
  }
}

// ---- acting on an attachment from its toast --------------------------------
//
// The toast that announces an attachment can open it, or show it in the file
// manager. Both take a path from the renderer, and a path from the renderer is
// never enough on its own — the whole app is built the other way round, with the
// renderer naming a session or a choice and main resolving the path itself.
//
// It can't be resolved from an id here: a dropped file is referenced where it
// lies, so an attachment's path is genuinely arbitrary and containment in
// `attachmentsDir()` would reject every drop. What makes it safe instead is that
// main only accepts a path it *minted itself* moments earlier: every successful
// attach records what it handed back, and nothing else is openable. The string
// crossing the bridge is a receipt for that, not permission to open a path.
//
// Opaque ids were considered and dropped: the toast already prints the path and
// its menu has to copy it, so the indirection would buy nothing.

/** Ceiling on the receipt book, matching the attachments folder's own file cap. */
const MAX_OPENABLE = MAX_FILES

/** Paths handed back by a successful attach, oldest first (Set insertion order). */
const openable = new Set<string>()

function remember(items: AttachedItem[]): void {
  for (const item of items) {
    // Re-inserting has to move it to the newest end, or a path attached twice
    // would still be evicted on its first insertion's schedule.
    openable.delete(item.path)
    openable.add(item.path)
  }
  while (openable.size > MAX_OPENABLE) {
    const oldest = openable.values().next().value
    if (oldest === undefined) break
    openable.delete(oldest)
  }
}

/**
 * What's actually on disk at an openable path, or the reason there is nothing to
 * open. The two refusals are kept apart because they mean different things: one
 * says the renderer named something this process never handed out, the other that
 * the file has gone since. The second is ordinary — `pruneAttachments()` runs on
 * every attach, so a toast can outlive its own file — and only the second is
 * worth a user ever reading.
 */
function openableTarget(
  path: string,
): { isDir: boolean; isImage: boolean } | { reason: string } {
  // Exact match against the string we handed out. There is nothing to normalise
  // here — normalising could only widen what gets in.
  if (!openable.has(path)) return { reason: "that isn't one of this run's attachments" }
  try {
    return { isDir: statSync(path).isDirectory(), isImage: IMAGE_EXT.has(ext(path)) }
  } catch {
    return { reason: "it isn't on disk any more — moved, renamed, or cleared out" }
  }
}

/** Hand a path to the OS and say what went wrong if it refused it. */
async function openWithOs(path: string): Promise<AttachOpenResult> {
  // Resolves to '' on success, an error string on failure. worktree.ts discards
  // that because opening a session folder is best-effort; here the click came
  // from a toast, so a silent nothing would read as the feature being broken.
  const error = await shell.openPath(path)
  if (error) return { ok: false, reason: error.slice(0, 160) }
  return { ok: true }
}

/**
 * Open an attachment. An image goes to the OS handler — a pasted screenshot has
 * no business opening in a code editor — and so does a folder, which opens as
 * itself. Everything else honours the editor configured for file links, falling
 * back to the OS handler when none is set, so a preference the user already
 * expressed for text files is neither ignored nor required.
 *
 * The kind is read off the disk rather than taken from the caller: the renderer's
 * copy of it is one more thing that would have to be trusted for no reason.
 */
export async function openAttachment(path: string): Promise<AttachOpenResult> {
  const target = openableTarget(path)
  if ('reason' in target) return { ok: false, reason: target.reason }

  if (target.isDir || target.isImage) return openWithOs(path)

  const { editor } = loadSettings().links
  const command = editor?.command?.trim()
  if (!command) return openWithOs(path)

  const exe = ptyMgr.expandHome(command) || command
  const name = editorName(command)
  const error = await launchDetached(exe, editorArgv(editor.args ?? [], path))
  if (error) return { ok: false, reason: `${name} wouldn't start: ${error.slice(0, 140)}` }
  return { ok: true }
}

/**
 * Show an attachment in the OS file manager, selected — including a folder, which
 * is revealed in its parent rather than opened (opening it is what the toast's
 * body does). `showItemInFolder` is synchronous and reports nothing, so the stat
 * inside `openableTarget` is the only failure this can honestly surface.
 */
export function revealAttachment(path: string): AttachOpenResult {
  const target = openableTarget(path)
  if ('reason' in target) return { ok: false, reason: target.reason }
  shell.showItemInFolder(path)
  return { ok: true }
}
