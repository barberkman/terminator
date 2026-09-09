import type { IBufferRange, ILink, ILinkHandler, ILinkProvider, Terminal } from '@xterm/xterm'
import type { LinkSettings } from '../../shared/types'
import { useStore } from '../state/store'
import * as editors from '../editor/registry'
import { C, FONT } from '../theme'

// Clickable links in terminal output.
//
// Three problems, and most of this file is the second and third:
//
//   1. Finding them. A URL that wraps across the right edge is still one URL, so
//      matching happens over a whole wrapped-line group, not a line at a time.
//   2. Not opening them by accident. xterm activates a link whenever mousedown
//      and mouseup land on the same one — which is exactly what selecting half a
//      URL to copy it, or double-clicking to select it, looks like. Selection
//      wins every time, so a click has to prove it was a click.
//   3. Saying where one goes before it's clicked. Hence the hover tooltip, which
//      names both the target and the browser that will open it.
//
// Opening itself belongs to the main process (main/links.ts), which re-validates
// every URL: what is on screen is output from someone else's program.

/** Movement between press and release, past which it was a drag, not a click. */
const DRAG_SLOP = 4
/**
 * How long an open waits for a second click to arrive. Double-clicking a URL is
 * how you select it, and the first half of that gesture is indistinguishable
 * from a click — so opening is deferred until the double-click window passes,
 * and any further press cancels it. Well under the time a browser takes to come
 * up, and the bias is the safe way round: an unopened link costs one more click.
 */
const DOUBLE_CLICK_MS = 250
/** How far a wrapped-line group is followed in each direction. */
const MAX_WRAP_ROWS = 8

const URL_RE = /\bhttps?:\/\/[^\s<>"'`\\^{}|]+/g
/** Path-ish tokens: at least one separator, so bare words are never candidates. */
const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?::\d+)?)?/g

export type LinkTarget =
  | { kind: 'web'; url: string }
  | { kind: 'file'; sessionId: string; path: string; line?: number; column?: number; label: string }

let settings: LinkSettings = {
  enabled: true,
  browsers: [],
  defaultBrowserId: '',
  openFilePaths: true,
  editor: { command: '', args: [] },
}

export function setLinkSettings(next: LinkSettings): void {
  settings = next
  if (!next.enabled) {
    hideTooltip()
    closeMenu()
  }
}

/** The browser a plain click uses, or undefined for the OS default handler. */
function defaultBrowser(): { id: string; name: string } | undefined {
  return settings.browsers.find((b) => b.id === settings.defaultBrowserId)
}

/**
 * The external editor's display name, or '' when none is configured — which is
 * also the switch between the two ways a clicked path can open.
 */
function externalEditor(): string {
  const command = settings.editor?.command?.trim() ?? ''
  if (!command) return ''
  const base = command.split(/[/\\]/).filter(Boolean).pop() ?? ''
  return base.replace(/\.(exe|cmd|bat|com)$/i, '') || 'your editor'
}

// ---- reading the buffer ----------------------------------------------------

/**
 * The text of the wrapped-line group containing `lineIndex`, plus the cell each
 * character came from. Built cell by cell rather than by arithmetic on columns,
 * so wide glyphs and combining marks can't slide the mapping out of alignment.
 */
interface Mapped {
  text: string
  at: { x: number; y: number }[]
}

function readWrappedGroup(term: Terminal, lineIndex: number): Mapped {
  const buf = term.buffer.active
  let top = lineIndex
  for (let i = 0; i < MAX_WRAP_ROWS && top > 0; i++) {
    if (!buf.getLine(top)?.isWrapped) break
    top--
  }
  let bottom = lineIndex
  for (let i = 0; i < MAX_WRAP_ROWS && bottom + 1 < buf.length; i++) {
    if (!buf.getLine(bottom + 1)?.isWrapped) break
    bottom++
  }

  const chars: string[] = []
  const at: { x: number; y: number }[] = []
  for (let y = top; y <= bottom; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x)
      if (!cell) continue
      // Width 0 is the trailing half of a wide glyph: no characters of its own.
      if (cell.getWidth() === 0) continue
      const s = cell.getChars() || ' '
      // Per UTF-16 unit, so regex indices and this map stay 1:1.
      for (let i = 0; i < s.length; i++) {
        chars.push(s[i])
        at.push({ x, y })
      }
    }
  }
  return { text: chars.join(''), at }
}

/**
 * The text currently occupying a buffer range.
 *
 * xterm caches a provider's reply per line, and a TUI that redraws a line in
 * place (or a terminal reset) can leave that cache describing text that has
 * since been overwritten. Cheap insurance, read at the moment it matters: a link
 * only acts if what it was made from is still there.
 */
function textAt(term: Terminal, range: IBufferRange): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = range.start.y - 1; y <= range.end.y - 1; y++) {
    const line = buf.getLine(y)
    if (!line) return ''
    const from = y === range.start.y - 1 ? range.start.x - 1 : 0
    const to = y === range.end.y - 1 ? range.end.x - 1 : term.cols - 1
    for (let x = from; x <= to; x++) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      out.push(cell.getChars() || ' ')
    }
  }
  return out.join('')
}

function rangeFor(group: Mapped, start: number, end: number): IBufferRange | null {
  const a = group.at[start]
  const b = group.at[end]
  if (!a || !b) return null
  // Buffer ranges are 1-based in both axes.
  return { start: { x: a.x + 1, y: a.y + 1 }, end: { x: b.x + 1, y: b.y + 1 } }
}

// ---- what counts as a link -------------------------------------------------

function occurrences(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}

/**
 * Trim what a sentence put there rather than the author: "see https://x/y." and
 * "(https://x/y)" both end one character early.
 */
export function trimUrl(raw: string): string {
  let s = raw
  let changed = true
  while (changed && s.length) {
    changed = false
    if (/[.,;:!?]$/.test(s)) {
      s = s.slice(0, -1)
      changed = true
    }
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ] as const) {
      if (s.endsWith(close) && occurrences(s, close) > occurrences(s, open)) {
        s = s.slice(0, -1)
        changed = true
      }
    }
  }
  return s
}

/** Split a `path:line:col` suffix off a candidate. */
function splitLine(token: string): { path: string; line?: number; column?: number } {
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(token)
  if (!m) return { path: token }
  return { path: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined }
}

/**
 * Cheap filter before asking the main process whether a token is a real file:
 * either it announces itself as a path (`/`, `./`, `../`, `~/`) or it ends in
 * something extension-shaped. Keeps `and/or` from costing a stat on every hover.
 */
function looksLikePath(token: string): boolean {
  const { path } = splitLine(token)
  if (path.length < 3) return false
  if (/^(~\/|\.{1,2}\/|\/)/.test(path)) return true
  return /\.[A-Za-z0-9]{1,12}$/.test(path)
}

// ---- the click guard -------------------------------------------------------

let down: { x: number; y: number } | null = null
let pendingOpen: number | null = null

/** Drop a deferred open — a second press means that click was part of something else. */
function cancelPendingOpen(): void {
  if (pendingOpen === null) return
  window.clearTimeout(pendingOpen)
  pendingOpen = null
}

/**
 * Whether an activation was a click and not the tail of a selection. xterm fires
 * activate on any mouseup that ends on the link it started on, so both a drag
 * across a URL and a double-click on one arrive here looking like clicks. A drag
 * is caught by the distance; a double-click by the selection it already made.
 */
function wasRealClick(term: Terminal, ev: MouseEvent): boolean {
  if (ev.button !== 0) return false
  // Ctrl/Cmd+click is the habitual open-a-link gesture, so it counts too. Shift
  // and Alt don't: terminals already spend those on extending a selection.
  if (ev.altKey || ev.shiftKey) return false
  if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > DRAG_SLOP) return false
  return !term.hasSelection()
}

// ---- opening ---------------------------------------------------------------

function toastError(text: string, sub: string): void {
  useStore.getState().pushToast({ tone: 'error', text, sub })
}

/** Hand a URL to the main process, which decides whether it opens at all. */
export async function openWeb(url: string, browserId?: string): Promise<void> {
  try {
    const res = await window.terminator.openLink(url, browserId)
    if (!res.ok) toastError("Couldn't open the link", res.reason)
  } catch (e) {
    toastError("Couldn't open the link", String(e).slice(0, 200))
  }
}

function baseName(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p
}

function rootOf(s: { worktreePath?: string; projectPath: string }): string {
  return (s.worktreePath || s.projectPath).replace(/[/\\]+$/, '')
}

function within(root: string, abs: string): boolean {
  return !!root && (abs === root || abs.startsWith(`${root}/`) || abs.startsWith(`${root}\\`))
}

/**
 * Open a file the terminal printed in an in-app Editor pane. The editor reads
 * through its session's root-scoped filesystem service, so the pane has to be
 * one whose folder actually contains the file — there's no pane to open it in
 * otherwise, and saying so beats a tab that can't load. With an external editor
 * configured that's the way out, so the message points at it.
 */
export function openInPane(path: string, line?: number): void {
  const st = useStore.getState()
  const candidates = Object.values(st.sessions).filter(
    (s) => s.kind === 'editor' && within(rootOf(s), path),
  )
  // Prefer one that's already on screen, so the file lands where you're looking.
  const target = candidates.find((s) => st.panes.includes(s.id)) ?? candidates[0]
  if (!target) {
    toastError(
      "Couldn't open that file",
      'no editor pane covers it — open one for this project, or set an external editor in Settings',
    )
    return
  }
  st.openSession(target.id)
  void editors.openFile(target.id, path, baseName(path)).then(() => {
    if (line) editors.revealLine(target.id, path, line)
  })
}

/** Hand a file to the configured editor; the main process re-checks the path. */
export async function openExternally(target: Extract<LinkTarget, { kind: 'file' }>): Promise<void> {
  try {
    const res = await window.terminator.openFileInEditor({
      sessionId: target.sessionId,
      path: target.path,
      line: target.line,
      column: target.column,
    })
    if (!res.ok) toastError("Couldn't open that file", res.reason)
  } catch (e) {
    toastError("Couldn't open that file", String(e).slice(0, 200))
  }
}

/** What a plain click does: the configured editor when there is one, else a pane. */
export function openFileTarget(target: Extract<LinkTarget, { kind: 'file' }>): void {
  if (externalEditor()) void openExternally(target)
  else openInPane(target.path, target.line)
}

function open(target: LinkTarget, browserId?: string): void {
  if (target.kind === 'web') void openWeb(target.url, browserId)
  else openFileTarget(target)
}

// ---- hover tooltip ---------------------------------------------------------

let tip: HTMLDivElement | null = null
let hovered: LinkTarget | null = null

export function hoveredTarget(): LinkTarget | null {
  return hovered
}

function describe(target: LinkTarget): { text: string; sub: string } {
  if (target.kind === 'file') {
    const editor = externalEditor()
    return {
      text: target.label,
      sub: editor
        ? `Click to open in ${editor} · right-click for an editor pane`
        : 'Click to open in an editor pane · right-click for more',
    }
  }
  const browser = defaultBrowser()
  const where = browser ? browser.name : 'your default browser'
  const more = settings.browsers.length > (browser ? 1 : 0) ? ' · right-click for others' : ''
  return { text: target.url, sub: `Click to open in ${where}${more}` }
}

export function hideTooltip(): void {
  tip?.remove()
  tip = null
}

/**
 * The "where does this go" affordance. Pointer-events off so it can never take a
 * click meant for the link underneath, and `xterm-hover` so xterm doesn't treat
 * a pointer over it as having left the link.
 */
function showTooltip(term: Terminal, ev: MouseEvent, target: LinkTarget): void {
  hideTooltip()
  const root = term.element
  if (!root || !settings.enabled) return
  const { text, sub } = describe(target)

  const el = document.createElement('div')
  el.className = 'xterm-hover'
  el.style.cssText = `
    position:absolute; z-index:20; pointer-events:none; max-width:min(560px,92%);
    padding:6px 9px; border-radius:7px; font-family:${FONT}; font-size:11px; line-height:1.45;
    background:${C.panel}; border:1px solid ${C.border3}; box-shadow:${C.shadowMenu};
    color:${C.textHi}; overflow-wrap:anywhere;`

  const main = document.createElement('div')
  main.textContent = text
  main.style.cssText = 'font-weight:600;'
  const hint = document.createElement('div')
  hint.textContent = sub
  hint.style.cssText = `color:${C.dim}; font-size:10.5px; margin-top:2px;`
  el.append(main, hint)
  root.appendChild(el)

  // Measured after insertion: it's sized by its own text.
  const rect = root.getBoundingClientRect()
  const x = ev.clientX - rect.left
  const y = ev.clientY - rect.top
  const above = y - el.offsetHeight - 12
  el.style.top = `${above >= 4 ? above : y + 22}px`
  el.style.left = `${Math.max(4, Math.min(x + 10, rect.width - el.offsetWidth - 4))}px`
  tip = el
}

// ---- right-click: open in a browser that isn't the default -----------------

let menu: HTMLDivElement | null = null
let closeMenuListeners: (() => void) | null = null

export function closeMenu(): void {
  menu?.remove()
  menu = null
  closeMenuListeners?.()
  closeMenuListeners = null
}

function menuItem(label: string, note: string | undefined, onPick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.style.cssText = `
    display:flex; align-items:center; gap:8px; width:100%; padding:7px 11px; border:none;
    background:transparent; color:${C.body}; font-family:${FONT}; font-size:12px; text-align:left;
    cursor:pointer; border-radius:6px; white-space:nowrap;`
  const text = document.createElement('span')
  text.textContent = label
  b.appendChild(text)
  if (note) {
    const tag = document.createElement('span')
    tag.textContent = note
    tag.style.cssText = `margin-left:auto; color:${C.dim}; font-size:10.5px;`
    b.appendChild(tag)
  }
  b.addEventListener('mouseenter', () => {
    b.style.background = C.hover
    b.style.color = C.textHi
  })
  b.addEventListener('mouseleave', () => {
    b.style.background = 'transparent'
    b.style.color = C.body
  })
  b.addEventListener('click', () => {
    closeMenu()
    onPick()
  })
  return b
}

/**
 * The way to the non-default browser without a trip through Settings. Only opens
 * over a link — a right-click anywhere else keeps its existing meaning (copy the
 * selection, or fall through to the program in the pane).
 */
export function openMenuForHovered(ev: MouseEvent): boolean {
  const target = hovered
  if (!settings.enabled || !target) return false
  closeMenu()
  hideTooltip()

  const el = document.createElement('div')
  el.style.cssText = `
    position:fixed; z-index:80; min-width:200px; max-width:340px; padding:4px;
    background:${C.panel}; border:1px solid ${C.border3}; border-radius:9px;
    box-shadow:${C.shadowMenu}; font-family:${FONT};`

  const heading = document.createElement('div')
  heading.textContent = target.kind === 'web' ? target.url : target.label
  heading.style.cssText = `
    padding:6px 11px 7px; font-size:10.5px; color:${C.dim};
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`
  el.appendChild(heading)

  if (target.kind === 'web') {
    for (const b of settings.browsers) {
      el.appendChild(
        menuItem(
          `Open in ${b.name}`,
          b.id === settings.defaultBrowserId ? 'default' : undefined,
          () => void openWeb(target.url, b.id),
        ),
      )
    }
    el.appendChild(
      menuItem(
        'Open in system default',
        settings.defaultBrowserId ? undefined : 'default',
        // '' asks for no configured browser, whatever the default is set to.
        () => void openWeb(target.url, ''),
      ),
    )
    el.appendChild(
      menuItem('Copy link', undefined, () => window.terminator.clipboardWrite(target.url)),
    )
  } else {
    const editor = externalEditor()
    if (editor) {
      el.appendChild(menuItem(`Open in ${editor}`, 'default', () => void openExternally(target)))
    }
    el.appendChild(
      menuItem('Open in editor pane', editor ? undefined : 'default', () =>
        openInPane(target.path, target.line),
      ),
    )
    el.appendChild(
      menuItem('Copy path', undefined, () => window.terminator.clipboardWrite(target.path)),
    )
  }

  document.body.appendChild(el)
  const w = el.offsetWidth
  const h = el.offsetHeight
  el.style.left = `${Math.max(6, Math.min(ev.clientX + 2, window.innerWidth - w - 6))}px`
  el.style.top = `${Math.max(6, Math.min(ev.clientY + 2, window.innerHeight - h - 6))}px`
  menu = el

  // Attached next tick so the click that opened the menu can't also close it.
  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) closeMenu()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeMenu()
    }
  }
  const timer = window.setTimeout(() => {
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
  }, 0)
  closeMenuListeners = () => {
    window.clearTimeout(timer)
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
  }
  return true
}

// ---- wiring ----------------------------------------------------------------

function makeLink(term: Terminal, range: IBufferRange, text: string, target: LinkTarget): ILink {
  return {
    range,
    text,
    decorations: { pointerCursor: true, underline: true },
    activate: (ev) => {
      if (!settings.enabled) return
      if (!wasRealClick(term, ev)) return
      if (textAt(term, range) !== text) return // the line was redrawn under it
      hideTooltip()
      cancelPendingOpen()
      pendingOpen = window.setTimeout(() => {
        pendingOpen = null
        open(target)
      }, DOUBLE_CLICK_MS)
    },
    hover: (ev) => {
      if (textAt(term, range) !== text) return
      hovered = target
      showTooltip(term, ev, target)
    },
    leave: () => {
      hovered = null
      hideTooltip()
    },
  }
}

/**
 * Scans the hovered wrapped-line group. URLs resolve synchronously; file paths
 * need the main process to confirm they exist inside the session's folder, so
 * those arrive on the callback a tick later — a token that isn't a real file
 * simply never becomes a link.
 */
function makeProvider(sessionId: string, term: Terminal): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      if (!settings.enabled) {
        callback(undefined)
        return
      }
      const group = readWrappedGroup(term, bufferLineNumber - 1)
      const links: ILink[] = []
      const taken: [number, number][] = []

      for (const m of group.text.matchAll(URL_RE)) {
        if (m.index === undefined) continue
        const url = trimUrl(m[0])
        if (!url) continue
        const range = rangeFor(group, m.index, m.index + url.length - 1)
        if (!range) continue
        taken.push([m.index, m.index + url.length - 1])
        links.push(makeLink(term, range, url, { kind: 'web', url }))
      }

      if (!settings.openFilePaths) {
        callback(links)
        return
      }

      const candidates: { token: string; start: number; end: number }[] = []
      for (const m of group.text.matchAll(PATH_RE)) {
        if (m.index === undefined) continue
        const token = m[0]
        const start = m.index
        const end = start + token.length - 1
        // Skip anything inside a URL we already matched (its host and path).
        if (taken.some(([a, b]) => start <= b && end >= a)) continue
        if (!looksLikePath(token)) continue
        candidates.push({ token, start, end })
      }
      if (!candidates.length) {
        callback(links)
        return
      }

      void Promise.all(
        candidates.map((c) =>
          window.terminator
            .resolveOutputPath(sessionId, splitLine(c.token).path)
            .catch(() => null),
        ),
      ).then((resolved) => {
        resolved.forEach((abs, i) => {
          if (!abs) return
          const c = candidates[i]
          const range = rangeFor(group, c.start, c.end)
          if (!range) return
          const { line, column } = splitLine(c.token)
          links.push(
            makeLink(term, range, c.token, {
              kind: 'file',
              sessionId,
              path: abs,
              line,
              column,
              label: c.token,
            }),
          )
        })
        callback(links)
      })
    },
  }
}

/**
 * OSC 8 hyperlinks — the escape sequence a program uses to say "this text is a
 * link" outright. Same guards and the same validation on the way out;
 * `allowNonHttpProtocols` stays off so a sequence can't name a scheme of its own.
 */
export function oscLinkHandler(term: Terminal): ILinkHandler {
  return {
    allowNonHttpProtocols: false,
    activate: (ev, text) => {
      if (!settings.enabled || !wasRealClick(term, ev)) return
      hideTooltip()
      void openWeb(text)
    },
    hover: (ev, text) => {
      hovered = { kind: 'web', url: text }
      showTooltip(term, ev, hovered)
    },
    leave: () => {
      hovered = null
      hideTooltip()
    },
  }
}

/** Register link detection on a terminal, and start watching for real clicks. */
export function attachLinks(sessionId: string, term: Terminal, host: HTMLDivElement): void {
  term.registerLinkProvider(makeProvider(sessionId, term))
  // Capture, so the press is recorded before xterm starts a selection with it.
  host.addEventListener(
    'mousedown',
    (e) => {
      down = { x: e.clientX, y: e.clientY }
      cancelPendingOpen()
      closeMenu()
    },
    true,
  )
}
