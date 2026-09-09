// Renderer half of "get an image or a file into this session": turn a paste or a
// drop into a list of files, hand them to the main process, and report back.
//
// Every path through here ends in a toast — attached (with a thumbnail, since the
// terminal itself can't show you one) or the reason it didn't.

import type { AttachFileInput, AttachResult } from '../shared/types'
import { useStore } from './state/store'

/** A pathless drop we're willing to read into memory before giving up. */
const MAX_INLINE_BYTES = 25 * 1024 * 1024

function fail(sub: string): void {
  useStore.getState().pushToast({ tone: 'error', text: "Couldn't attach", sub })
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
  })
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
