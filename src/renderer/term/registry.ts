import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { C, FONT } from '../theme'

// One persistent xterm Terminal per session, alive for the session's lifetime
// regardless of which pane (if any) currently shows it. Hidden terminals are
// parked in an offscreen holder so their buffer/scrollback survive layout
// changes. Terminal bytes are written here imperatively, never through React.

interface Entry {
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
}

const entries = new Map<string, Entry>()
let holder: HTMLDivElement | null = null
let wired = false

// Terminal font family is configurable in Settings; size scales with the global
// UI zoom (so the intrinsic xterm size stays fixed and zoom magnifies everything).
const BASE_FONT_SIZE = 13
let curFontFamily = FONT

export function setFontFamily(family: string): void {
  curFontFamily = family || FONT
  for (const e of entries.values()) {
    e.term.options.fontFamily = curFontFamily
  }
  refitVisible()
}

/** Refit all on-screen terminals (after a font-family or UI-zoom change). */
export function refitVisible(): void {
  for (const [id, e] of entries) {
    if (e.host.parentElement && e.host.parentElement !== holder) {
      try {
        e.fit.fit()
      } catch {
        // not measurable yet
      }
      window.terminator.resizePty(id, e.term.cols, e.term.rows)
    }
  }
}

function ensureHolder(): HTMLDivElement {
  if (!holder) {
    holder = document.createElement('div')
    holder.style.cssText =
      'position:absolute;left:-99999px;top:0;width:900px;height:600px;overflow:hidden;'
    document.body.appendChild(holder)
  }
  return holder
}

function wireGlobalStreams(): void {
  if (wired) return
  wired = true
  window.terminator.onPtyData((p) => {
    entries.get(p.id)?.term.write(p.data)
  })
  window.terminator.onPtyExit((p) => {
    entries.get(p.id)?.term.write('\r\n\x1b[2m── process exited ──\x1b[0m\r\n')
  })
  // Mode switch relaunches the pty; clear the terminal so the resumed Claude TUI
  // draws into a clean buffer, and return keyboard focus to it (the click was on
  // the lock button) so the user can type immediately.
  window.terminator.onPtyReset((id) => {
    const e = entries.get(id)
    if (!e) return
    e.term.reset()
    requestAnimationFrame(() => e.term.focus())
  })
}

export function getOrCreate(id: string): Entry {
  wireGlobalStreams()
  const existing = entries.get(id)
  if (existing) return existing

  const term = new Terminal({
    fontFamily: curFontFamily,
    fontSize: BASE_FONT_SIZE,
    lineHeight: 1.0,
    cursorBlink: true,
    scrollback: 8000,
    allowProposedApi: true,
    theme: {
      background: C.bg,
      foreground: C.text,
      cursor: C.accent,
      cursorAccent: C.bg,
      selectionBackground: 'rgba(217,119,87,0.3)',
    },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  const host = document.createElement('div')
  host.style.cssText = 'width:100%;height:100%;'
  ensureHolder().appendChild(host)
  term.open(host)
  term.onData((d) => window.terminator.writePty(id, d))

  // Copy/paste: Ctrl/Cmd+C copies the selection (and otherwise passes ^C through
  // as SIGINT); Ctrl/Cmd+V pastes. Returning false stops xterm from sending the key.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || e.altKey) return true
    const k = e.key.toLowerCase()
    if (k === 'c') {
      if (term.hasSelection()) {
        window.terminator.clipboardWrite(term.getSelection())
        term.clearSelection()
        return false
      }
      return true // no selection → let ^C reach the shell (interrupt)
    }
    if (k === 'v') {
      // preventDefault stops the browser's native paste into xterm's textarea;
      // without it both that and the manual paste below fire (pasting twice).
      e.preventDefault()
      const text = window.terminator.clipboardRead()
      if (text) term.paste(text)
      return false
    }
    return true
  })

  const entry: Entry = { term, fit, host }
  entries.set(id, entry)
  return entry
}

/** Move a session's terminal into a visible pane element and size it. */
export function attach(id: string, parent: HTMLElement): void {
  const e = getOrCreate(id)
  if (e.host.parentElement !== parent) parent.appendChild(e.host)
}

/** Park a terminal offscreen (keeps it alive + receiving output). */
export function detach(id: string): void {
  const e = entries.get(id)
  if (e) ensureHolder().appendChild(e.host)
}

/** Fit to current container and push the new size to the PTY. */
export function refit(id: string): { cols: number; rows: number } {
  const e = entries.get(id)
  if (!e) return { cols: 80, rows: 24 }
  try {
    e.fit.fit()
  } catch {
    // container not measurable yet
  }
  window.terminator.resizePty(id, e.term.cols, e.term.rows)
  return { cols: e.term.cols, rows: e.term.rows }
}

export function focus(id: string): void {
  entries.get(id)?.term.focus()
}

export function size(id: string): { cols: number; rows: number } {
  const e = entries.get(id)
  return e ? { cols: e.term.cols, rows: e.term.rows } : { cols: 80, rows: 24 }
}

export function dispose(id: string): void {
  const e = entries.get(id)
  if (!e) return
  try {
    e.term.dispose()
  } catch {
    // ignore
  }
  e.host.remove()
  entries.delete(id)
}
