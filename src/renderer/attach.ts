// Renderer half of "get an image or a file into this session": turn a paste or a
// drop into a list of files, hand them to the main process, and report back.
//
// Every path through here ends in a toast — attached (with a thumbnail, since the
// terminal itself can't show you one) or the reason it didn't.

import type { AttachFileInput, AttachResult } from '../shared/types'
import { useStore } from './state/store'

/** A pathless drop we're willing to read into memory before giving up. */
const MAX_INLINE_BYTES = 25 * 1024 * 1024

function failed(text: string, sub: string): void {
  useStore.getState().pushToast({ tone: 'error', text, sub })
}

function fail(sub: string): void {
  failed("Couldn't attach", sub)
}

/**
 * Open an attachment from the toast that announced it. Which program that means is
 * decided in the main process from what's actually on disk — an image goes to the
 * OS viewer, anything else to the configured editor — so there's nothing to choose
 * here beyond reporting a refusal.
 */
export async function openAttachment(path: string): Promise<void> {
  try {
    const res = await window.terminator.openAttachment(path)
    if (!res.ok) failed("Couldn't open that attachment", res.reason)
  } catch (e) {
    failed("Couldn't open that attachment", String(e).slice(0, 200))
  }
}

/** Show an attachment in the OS file manager, selected. */
export async function revealAttachment(path: string): Promise<void> {
  try {
    const res = await window.terminator.revealAttachment(path)
    if (!res.ok) failed("Couldn't show that attachment", res.reason)
  } catch (e) {
    failed("Couldn't show that attachment", String(e).slice(0, 200))
  }
}

function report(result: AttachResult): void {
  const push = useStore.getState().pushToast
  if (!result.ok) {
    fail(result.reason)
    return
  }
  const { items, note } = result
  const one = items.length === 1 ? items[0] : null
  const sub = [one ? one.path : items.map((i) => i.name).join(', '), note]
    .filter(Boolean)
    .join(' · ')
  push({
    tone: 'ok',
    text: one ? `Attached ${one.name}` : `Attached ${items.length} items`,
    sub,
    thumb: items.find((i) => i.thumb)?.thumb,
    // Only the single-item case has one thing to point at. A multi-item attach
    // could offer its common parent directory instead, but "open" would stop
    // meaning one file, so it stays a plain report.
    action: one ? { path: one.path, kind: one.kind } : undefined,
  })
}

/**
 * The composer's half of the same story. It doesn't toast on success, because the
 * chip that appears in the box *is* the receipt — a toast as well would be the app
 * telling you twice about something already on screen. Failures still toast:
 * nothing gets to fail quietly.
 */
function intoComposer(sessionId: string, result: AttachResult): void {
  if (!result.ok) {
    fail(result.reason)
    return
  }
  const st = useStore.getState()
  const held = st.attachments[sessionId] ?? []
  // Same path twice is one chip: dropping a file you already attached should not
  // send the path to Claude twice.
  const fresh = result.items.filter((i) => !held.some((h) => h.path === i.path))
  if (fresh.length) st.setAttachments(sessionId, [...held, ...fresh])
}

/** Attach a drop to the conversation view's composer rather than typing it. */
export async function attachDropToComposer(sessionId: string, dt: DataTransfer): Promise<void> {
  try {
    const files = await filesFromDrop(dt)
    if (!files.length) {
      fail('that drop carried no files — only files and folders can be attached')
      return
    }
    intoComposer(sessionId, await window.terminator.attachFiles(sessionId, files, 'caller'))
  } catch (e) {
    fail(String(e).slice(0, 200))
  }
}

/** Attach the clipboard's image to the composer (the caller has checked there is one). */
export async function attachClipboardToComposer(sessionId: string): Promise<void> {
  try {
    intoComposer(sessionId, await window.terminator.attachClipboardImage(sessionId, 'caller'))
  } catch (e) {
    fail(String(e).slice(0, 200))
  }
}

/** Attach files the composer got from a paste — they arrive as bytes, not paths. */
export async function attachFilesToComposer(
  sessionId: string,
  files: AttachFileInput[],
): Promise<void> {
  try {
    if (!files.length) return
    intoComposer(sessionId, await window.terminator.attachFiles(sessionId, files, 'caller'))
  } catch (e) {
    fail(String(e).slice(0, 200))
  }
}

/**
 * What a drop actually carries. A file dragged from a file manager has a real
 * path and is referenced where it lies; one dragged out of a browser has no path,
 * only bytes, so those are read here and written out on the main side.
 */
async function filesFromDrop(dt: DataTransfer): Promise<AttachFileInput[]> {
  const files = Array.from(dt.files)
  const out: AttachFileInput[] = []
  for (const file of files) {
    const path = window.terminator.pathForFile(file)
    if (path) {
      out.push({ path })
      continue
    }
    if (file.size > MAX_INLINE_BYTES) {
      out.push({ name: file.name }) // no bytes → main reports it as too large
      continue
    }
    out.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
  }
  return out
}

/** Attach whatever was dropped on a session's pane. */
export async function attachDrop(sessionId: string, dt: DataTransfer): Promise<void> {
  try {
    const files = await filesFromDrop(dt)
    if (!files.length) {
      fail('that drop carried no files — only files and folders can be attached')
      return
    }
    report(await window.terminator.attachFiles(sessionId, files))
  } catch (e) {
    // Nothing gets to fail quietly, including the plumbing itself.
    fail(String(e).slice(0, 200))
  }
}

/** Attach the clipboard's image (the caller has already checked there is one). */
export async function attachClipboardImage(sessionId: string): Promise<void> {
  try {
    report(await window.terminator.attachClipboardImage(sessionId))
  } catch (e) {
    fail(String(e).slice(0, 200))
  }
}
