// Claude's Ctrl+G, routed into an in-app Editor pane.
//
// Ctrl+G is Claude Code's own key, not ours — the pane forwards it to the pty and
// never sees it. What Claude does with it is: write the prompt to a temp file, run
// `$VISUAL || $EDITOR` on it, and read the file back when that process exits. So
// the way to put the prompt in an Editor pane is to *be* that program: point
// $VISUAL at a helper that hands the file to this app and then blocks until the
// app says the edit is over (prompt-editor-source.ts).
//
// This module owns both halves of that: assembling a $VISUAL Claude can actually
// parse, and the lifetime of each edit. The invariant that matters more than any
// feature here is that **every way an edit can end releases the helper** — the
// button, the tab closing, the session dying, the window going, a renderer that
// never got the tab up, the app quitting. A missed release is a Claude session
// stuck on a blank alternate screen with no way out but Ctrl+C.

import { chmodSync, lstatSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { Channels } from '../shared/channels'
import { IN_APP_EDITOR_ID, type PromptEditorStatus } from '../shared/types'
import { absPath, grantPath, revokePath } from './fs-service'
import { PROMPT_EDITOR_SOURCE, posixShimSource } from './prompt-editor-source'
import { loadSettings } from './settings'
import { getSession } from './state'

/**
 * How long an edit may sit un-opened before it is released.
 *
 * It covers one gap only — between "the helper called in" and "the renderer has a
 * tab up" — because that is the window in which nobody can yet press anything. A
 * page mid-reload in dev is the realistic way in. Once the tab exists the edit is
 * untimed again: a prompt someone is still writing must never be yanked away.
 */
const OPEN_TIMEOUT_MS = 15_000

/**
 * The basenames Claude reads as "this is a GUI editor", which make it spawn the
 * program *detached* and read the file straight back instead of waiting. That
 * would silently discard every edit rather than fail loudly, so the name of
 * whatever ends up as argv0 is load-bearing and gets checked rather than assumed.
 * `terminator` and `electron` are both clear today — this guards the day someone
 * changes `productName`.
 */
const GUI_EDITOR_NAMES = ['code', 'cursor', 'windsurf', 'codium', 'subl', 'atom', 'gedit', 'notepad++', 'notepad']

let mainWindow: BrowserWindow | null = null

export function setWindow(w: BrowserWindow): void {
  mainWindow = w
}

// ---- installing the helper -------------------------------------------------

let helperFile = ''
let shimDir = ''
/** What $VISUAL gets, or '' if it can't be expressed on this machine. */
let command = ''
/** Why, when it can't. Shown in Settings rather than failing silently. */
let unavailable = 'the helper has not been set up.'

function guiEditorNameIn(argv0: string): string {
  const name = basename(argv0)
  return GUI_EDITOR_NAMES.find((n) => name.includes(n)) ?? ''
}

/**
 * A writable directory with no space in its path, or '' if there is none.
 *
 * Named per user and reused across runs rather than made fresh each time: the app
 * can be killed rather than quit, and a new directory per launch would pile up in
 * everyone's temp folder. One stable path is also one less thing that moves under
 * a shell that still has our $VISUAL exported.
 *
 * /tmp is shared, so a name someone else could have got to first is checked rather
 * than trusted — a symlink sitting there would otherwise have us write through it.
 */
function shimHome(): string {
  const name = `terminator-${process.getuid?.() ?? 0}`
  for (const base of [tmpdir(), '/tmp']) {
    if (!base || /\s/.test(base)) continue
    const dir = join(base, name)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const st = lstatSync(dir)
      if (!st.isDirectory()) continue
      if (process.getuid && st.uid !== process.getuid()) continue
      return dir
    } catch {
      // try the next candidate
    }
  }
  return ''
}

/**
 * Write the helper and work out what $VISUAL can say. Called once at startup,
 * before any session can be launched.
 *
 * The awkward part is that Claude parses $VISUAL as `cmd.split(" ")` with no
 * quoting: every token has to be space-free, and neither of the two paths we need
 * is ours to choose. `process.execPath` is `C:\Program Files\...` on a per-machine
 * Windows install, and userData is `~/Library/Application Support/Terminator` on
 * macOS as shipped. So:
 *
 *   • POSIX — $VISUAL is a *single token*: a tiny `sh` shim in a space-free temp
 *     dir, with both real paths quoted inside it where no splitting happens. Used
 *     always, not only when the direct form would have failed, so there is one
 *     path through this and it is the one that gets exercised.
 *   • Windows — a `.cmd` shim can't be spawned without a shell (Node refuses since
 *     the 2024 argument-injection fix), so there is nothing to hide the paths
 *     behind: the two go into $VISUAL directly, and a space in either rules the
 *     feature out. The default install (`%LOCALAPPDATA%\Programs\Terminator`) and
 *     userData (`%APPDATA%\Terminator`) are both space-free, so this bites only a
 *     per-machine install or a username with a space in it.
 *
 * Failing here is not a broken app: $VISUAL simply goes unset, and Ctrl+G keeps
 * doing exactly what it did before.
 */
export function installPromptEditor(): void {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  helperFile = join(dir, 'prompt-editor.cjs')
  writeFileSync(helperFile, PROMPT_EDITOR_SOURCE, 'utf8')

  if (process.platform === 'win32') {
    const offending = guiEditorNameIn(process.execPath)
    if (offending) {
      unavailable = `Claude reads a program called "${basename(process.execPath)}" as a windowed editor and wouldn't wait for it, so the edit would be thrown away.`
    } else if (/\s/.test(process.execPath) || /\s/.test(helperFile)) {
      unavailable =
        "Claude's editor setting can't hold a path with a space in it, and this app is installed under one. Installing it for just your user (the default) puts it somewhere with no space."
    } else {
      command = `${process.execPath} ${helperFile}`
    }
    return
  }

  shimDir = shimHome()
  if (!shimDir) {
    unavailable = "Claude's editor setting can't hold a path with a space in it, and there's no temp folder here without one."
    return
  }
  const shim = join(shimDir, 'prompt-editor')
  const offending = guiEditorNameIn(shim)
  if (offending) {
    unavailable = `Claude reads a program called "${basename(shim)}" as a windowed editor and wouldn't wait for it.`
    return
  }
  try {
    writeFileSync(shim, posixShimSource(process.execPath, helperFile), 'utf8')
    chmodSync(shim, 0o700)
  } catch (e) {
    unavailable = `The helper couldn't be written to ${shimDir} (${String(e).slice(0, 120)}).`
    return
  }
  command = shim
}

/**
 * Let go of every live edit, so nothing is left blocked on a window that is going
 * away. The shim itself stays on disk: it is a stable per-user path the next run
 * reuses, and a leftover one can only ever exit immediately — the port it was told
 * about died with the app.
 */
export function disposePromptEditor(): void {
  finishAllEdits()
}

/**
 * The value for a Claude session's `VISUAL`, or '' to leave the environment alone.
 *
 * Empty is the default and means Ctrl+G is untouched: Claude falls back to the
 * user's own `$VISUAL`/`$EDITOR` exactly as it did before this feature existed.
 * Read at launch, which is why the setting applies to sessions started after it.
 */
export function promptEditorCommand(): string {
  if (loadSettings().promptEditorId !== IN_APP_EDITOR_ID) return ''
  return command
}

export function promptEditorStatus(): PromptEditorStatus {
  return command ? { available: true } : { available: false, reason: unavailable }
}

// ---- the lifetime of one edit ----------------------------------------------

interface Edit {
  /** Absolute path — the edit's identity everywhere, renderer included. */
  file: string
  /** The Claude session blocked on it. */
  sessionId: string
  /** Held open for the whole edit. Ending it is what lets Claude carry on. */
  res: ServerResponse
  /** Cleared once the renderer reports a tab. See OPEN_TIMEOUT_MS. */
  openTimer: NodeJS.Timeout | null
}

const edits = new Map<string, Edit>()

/**
 * A helper called in: a session pressed Ctrl+G and is now blocked on us.
 *
 * `res` is not answered here — holding it open *is* the feature. Every path that
 * declines the edit ends it immediately instead, because a session that can't be
 * helped must get its prompt back rather than wait for nothing.
 */
export function beginEdit(payload: Record<string, unknown>, res: ServerResponse): void {
  const raw = typeof payload.file === 'string' ? payload.file : ''
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  const win = mainWindow
  const session = sessionId ? getSession(sessionId) : undefined
  const readable = !!raw && ((): boolean => {
    try {
      return statSync(raw).isFile()
    } catch {
      return false
    }
  })()
  if (!readable || !session || !win || win.isDestroyed() || win.webContents.isDestroyed()) {
    res.end()
    return
  }

  const file = absPath(raw)
  // Supersede before granting, never after — `finishEdit` revokes, and revoking
  // after the grant would take away the one this edit just made.
  //
  // Two things get superseded. A session can only be in one Ctrl+G at a time
  // (Claude is blocked until it returns), so anything still open for this one is a
  // leftover from a helper that died without closing its socket. And the file can
  // repeat: Claude names the temp file after a hash of the prompt, so pressing
  // Ctrl+G twice on the same text asks for the same path back.
  for (const e of [...edits.values()]) {
    if (e.sessionId === sessionId || e.file === file) finishEdit(e.file)
  }
  grantPath(file)

  // No socket timeout, unlike every other route: the response *is* the edit, and an
  // edit takes as long as the typing takes. Keepalive so an app or container that
  // dies without unwinding drops the socket rather than leaving the helper hanging.
  res.setTimeout(0)
  res.socket?.setKeepAlive(true, 30_000)

  const edit: Edit = { file, sessionId, res, openTimer: null }
  edits.set(file, edit)
  // Covers the helper being killed, the pty dying under it, and Ctrl+C in the pane.
  // Guarded on identity, not just the path: ending a superseded edit's response
  // closes its socket, and an unguarded handler would then take the replacement —
  // which shares the path whenever Ctrl+G is pressed twice on the same text — down
  // with it.
  res.on('close', () => {
    if (edits.get(file) === edit) finishEdit(file)
  })

  // The session is blocked from this moment, on a tab that may be behind another
  // window — the one case in this app where taking the foreground is the kinder
  // answer, because the way out is a button the user can't otherwise see.
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send(Channels.promptEdit, { file, sessionId, sessionName: session.name })
  edit.openTimer = setTimeout(() => {
    if (edits.get(file) === edit) finishEdit(file)
  }, OPEN_TIMEOUT_MS)
}

/** The renderer has a tab up: stop counting, the edit now lasts as long as it lasts. */
export function markEditOpen(file: string): void {
  const e = edits.get(file)
  if (!e?.openTimer) return
  clearTimeout(e.openTimer)
  e.openTimer = null
}

/**
 * Release the helper, however we got here. Idempotent on purpose — `res.on('close')`
 * and the caller that closed it both land here, and so do the app-level sweeps.
 */
export function finishEdit(file: string): void {
  const e = edits.get(file)
  if (!e) return
  edits.delete(file)
  if (e.openTimer) clearTimeout(e.openTimer)
  revokePath(file)
  try {
    e.res.end()
  } catch {
    // the socket may already be gone; the helper exits on that too
  }
  // Tell the renderer even when the renderer is who asked (it ignores those): the
  // ends it *doesn't* know about are the ones that matter — Ctrl+C in the pane, the
  // session stopping — and after any of them the tab is still on screen claiming
  // somebody is waiting for it, over a file it can no longer even save.
  const win = mainWindow
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(Channels.promptEditEnded, file)
  }
}

/** Every live edit: the window closing, the server stopping, the app quitting. */
export function finishAllEdits(): void {
  for (const file of [...edits.keys()]) finishEdit(file)
}
