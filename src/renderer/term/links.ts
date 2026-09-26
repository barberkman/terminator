import type { IBufferRange, ILink, ILinkHandler, ILinkProvider, Terminal } from '@xterm/xterm'
import {
  IN_APP_BROWSER_ID,
  IN_APP_BROWSER_NAME,
  IN_APP_EDITOR_ID,
  type LinkSettings,
  type Session,
} from '../../shared/types'
import { hostFolder, parseWslUnc } from '../../shared/wsl-path'
import { webUrl, webUrlRe } from '../../shared/url'
import type { ProjectRef } from '../menus'
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
// every URL: what is on screen is output from someone else's program. The one
// exception is the in-app browser, which is a pane to raise rather than a program
// to launch — so the renderer resolves that target itself, and runs the identical
// `webUrl` check from shared/ on the way, because it is the only route into the app
// that never reaches main/links.ts and must not also be the only one that skips it.

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

const URL_RE = webUrlRe()
/**
 * Path-ish tokens: at least one separator, so bare words are never candidates.
 *
 * Built from parts because of the brace group. `a/b.{h,cpp}` is one token naming two
 * files — Claude prints it constantly when it lists what it changed — and without the
 * `{…}` here the match stops at the `{`, leaving `a/b.` , which `looksLikePath` then
 * rejects for having no extension. So the form that most wants to be a link is the one
 * that never was. Trailing only, and two alternatives minimum: a lone `{a}` or an empty
 * `{}` stays the plain token it already was, and requiring the comma is what keeps
 * `${FOO}` out. See `expandBraces` for what the group turns into.
 */
const SEG = String.raw`[\w.@+-]+`
const BRACE = String.raw`\{${SEG}(?:,${SEG})+\}`
const PATH_RE = new RegExp(
  String.raw`(?:~\/|\.{1,2}\/|\/)?${SEG}(?:\/${SEG})+(?:${BRACE})?(?::\d+(?::\d+)?)?`,
  'g',
)
/** How many alternatives a brace group may name before it stops looking like a path. */
const MAX_BRACE_ALTS = 8

export type LinkTarget =
  // `sessionId` is whose project a browser pane opens under — a link is printed
  // *somewhere*, and that somewhere is the only sensible home for the pane showing
  // it. Optional because a link in the notes overlay has no session behind it.
  | { kind: 'web'; url: string; sessionId?: string }
  | { kind: 'file'; sessionId: string; path: string; line?: number; column?: number; label: string }

let settings: LinkSettings = {
  enabled: true,
  browsers: [],
  defaultBrowserId: '',
  openFilePaths: true,
  editor: { command: '', args: [] },
  defaultEditorId: '',
}

export function setLinkSettings(next: LinkSettings): void {
  settings = next
  if (!next.enabled) {
    hideTooltip()
    closeMenu()
  }
}

/**
 * The target a plain click uses, named, or undefined for the OS default handler.
 * The in-app browser is one of these like any other: it is a reserved id rather
 * than a flag, so everywhere a browser is chosen it is simply another choice.
 */
function defaultTarget(): { id: string; name: string } | undefined {
  const id = settings.defaultBrowserId
  if (id === IN_APP_BROWSER_ID) return { id, name: IN_APP_BROWSER_NAME }
  return settings.browsers.find((b) => b.id === id)
}

/**
 * The external editor's display name, or '' when none is configured — which is
 * also the switch between the two ways a clicked path can open. Exported because
 * an attachment toast offers the same verb and has to name the same program.
 */
export function externalEditor(): string {
  const command = settings.editor?.command?.trim() ?? ''
  if (!command) return ''
  const base = command.split(/[/\\]/).filter(Boolean).pop() ?? ''
  return base.replace(/\.(exe|cmd|bat|com)$/i, '') || 'your editor'
}

/**
 * Whether a plain click on a file path opens an Editor pane rather than the
 * configured program.
 *
 * Two ways to be true, and they are not the same thing. Picking the pane in Settings
 * says so outright. Having no external editor at all says it by default — which is
 * why this is a question of its own and not just `!externalEditor()`: that answer is
 * still load-bearing for the things that are about the *program* rather than the
 * default (whether the right-click menu has a row to offer, how the tooltip words
 * itself, and what an attachment's Open says, since an attachment lives outside every
 * session root and no pane can open one).
 */
function inAppEditorIsDefault(): boolean {
  return settings.defaultEditorId === IN_APP_EDITOR_ID || !externalEditor()
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

/** One path a token names, and where its clickable span sits inside that token. */
interface Expansion {
  path: string
  /** Offsets into the token, inclusive, for `rangeFor`. */
  from: number
  to: number
}

/**
 * The paths a token names. `a/b.{h,cpp}` names two; everything else names itself.
 *
 * The span of each is the *alternative alone* — `h`, then `cpp` — not the whole token.
 * Underlining `a/b.{h,cpp}` as one link would leave a click with no honest answer to
 * which file it opens, and picking the first would be a guess made silently. Two small
 * targets that each say what they do beat one big one that doesn't; the caller pairs
 * each with a `label` of the full expanded path, so the hover names the file before the
 * click commits to it.
 *
 * Deliberately unsupported: nesting, more than one group, ranges (`{1..3}`), and any
 * group naming more than `MAX_BRACE_ALTS` files — those fall back to the whole token,
 * which then lives or dies by `looksLikePath` exactly as it did before.
 */
function expandBraces(token: string): Expansion[] {
  const whole: Expansion[] = [{ path: token, from: 0, to: token.length - 1 }]
  const open = token.indexOf('{')
  if (open < 0) return whole
  const close = token.indexOf('}', open)
  if (close < 0) return whole
  const alts = token.slice(open + 1, close).split(',')
  if (alts.length < 2 || alts.length > MAX_BRACE_ALTS || alts.some((a) => !a)) return whole

  const prefix = token.slice(0, open)
  const suffix = token.slice(close + 1)
  const out: Expansion[] = []
  // Walk the alternatives in order, tracking where each one starts, so the spans are
  // the characters actually on screen rather than anything recomputed from the text.
  let at = open + 1
  for (const alt of alts) {
    out.push({ path: prefix + alt + suffix, from: at, to: at + alt.length - 1 })
    at += alt.length + 1 // the alternative, then its comma
  }
  return out
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

/**
 * The project a browser pane should open under: the one the link came from, else
 * whatever is in the focused pane, else any session at all. A browser session needs
 * a real folder like every other — `createSession` resolves an empty path to the
 * process's own working directory, and a session rooted there is a session rooted
 * somewhere nobody chose.
 */
function projectForBrowser(fromId?: string): ProjectRef | undefined {
  const st = useStore.getState()
  const focusedId = st.panes[st.focused]
  const candidate =
    (fromId ? st.sessions[fromId] : undefined) ??
    (focusedId ? st.sessions[focusedId] : undefined) ??
    Object.values(st.sessions).find((x) => !!x.projectPath)
  if (!candidate?.projectPath) return undefined
  // The runtime comes along, or a link printed by a WSL session would open its pane
  // under a Windows project of the same name.
  return { name: candidate.projectName, path: candidate.projectPath, runtime: candidate.runtime }
}

/**
 * Show a URL in a browser pane — a new one each time, the way a browser opens a new
 * tab rather than replacing the page you were already reading. The pane belongs to
 * the project the link was printed in, so it groups under it in the sidebar and has
 * a real folder to belong to.
 *
 * The cost is that they accumulate: a browser session is a session like any other,
 * so closing the pane leaves it in the sidebar, and it comes back after a restart
 * until you remove it.
 */
async function openInAppBrowser(url: string, fromId?: string): Promise<void> {
  const project = projectForBrowser(fromId)
  if (!project) {
    toastError("Couldn't open the link", 'open a session first — a browser pane opens in its project')
    return
  }
  try {
    const made = await window.terminator.createSession({
      kind: 'browser',
      mode: 'normal',
      projectName: project.name,
      projectPath: project.path,
      ...(project.runtime ? { runtime: project.runtime } : {}),
      url,
    })
    const st = useStore.getState()
    st.upsert(made)
    st.openSession(made.id)
  } catch (e) {
    toastError("Couldn't open the link", String(e).slice(0, 200))
  }
}

/**
 * Open a web link, wherever it was clicked.
 *
 * `browserId` picks the target: `undefined` means "whatever a plain click does",
 * `''` means the OS handler whatever the default is, and anything else is an id.
 * The in-app browser is the one target resolved here rather than in main — it is a
 * pane to raise, not a program to launch — and it gets the same `webUrl` check main
 * would have run, so no route into the app skips the validation.
 */
export async function openWeb(url: string, browserId?: string, sessionId?: string): Promise<void> {
  const wanted = browserId === undefined ? settings.defaultBrowserId : browserId
  if (wanted === IN_APP_BROWSER_ID) {
    const safe = webUrl(url)
    if (!safe) {
      toastError("Couldn't open the link", 'only http and https links can be opened')
      return
    }
    await openInAppBrowser(safe, sessionId)
    return
  }
  try {
    const res = await window.terminator.openLink(url, browserId)
    if (!res.ok) toastError("Couldn't open the link", res.reason)
  } catch (e) {
    toastError("Couldn't open the link", String(e).slice(0, 200))
  }
}

/**
 * Leave the app with this URL. The browser pane's own escape hatch, and the answer
 * when a site refuses to run in an embedded browser at all — so it must never route
 * back inside: if the default *is* the in-app browser, the OS handler is the only
 * honest reading of "not here".
 */
export async function openOutsideApp(url: string): Promise<void> {
  await openWeb(url, settings.defaultBrowserId === IN_APP_BROWSER_ID ? '' : undefined)
}

function baseName(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p
}

/** A session's folder as the editor reads it — a WSL session's through its distro's share. */
function rootOf(s: Session): string {
  return hostFolder(s).replace(/[/\\]+$/, '')
}

function within(root: string, abs: string): boolean {
  return !!root && (abs === root || abs.startsWith(`${root}/`) || abs.startsWith(`${root}\\`))
}

/**
 * Find — or make — the in-app Editor pane a file belonging to `sessionId` should
 * open in, and put it on screen.
 *
 * `covers` is how a caller says which panes are even candidates. A clicked path
 * needs one whose folder *contains* the file, because the editor reads through its
 * session's root-scoped filesystem service and a pane that doesn't contain the file
 * can't read it. Claude's Ctrl+G passes nothing: its prompt lives in the system temp
 * dir, so no pane's folder contains it and the pane is only somewhere to put the
 * tab — which makes the right one the pane belonging to the session that asked.
 *
 * Reused, not stacked: a link opens a new browser pane every time, the way a browser
 * opens a tab, but a second Editor pane on the same folder is the same file tree twice
 * over. The pane is per project; the tabs inside it are the per-file part. One already
 * on screen wins, so the file lands where you're looking.
 *
 * A toast explains every null. Callers still have their own cleaning up to do.
 */
export async function ensureEditorPane(
  sessionId: string,
  covers?: (root: string) => boolean,
): Promise<Session | null> {
  const st = useStore.getState()
  const from = st.sessions[sessionId]
  const candidates = Object.values(st.sessions).filter(
    (s) =>
      s.kind === 'editor' &&
      (covers ? covers(rootOf(s)) : !!from && rootOf(s) === rootOf(from)),
  )
  let target = candidates.find((s) => st.panes.includes(s.id)) ?? candidates[0]

  if (!target) {
    // Rooted on the session that asked, not on whatever happens to be focused. A
    // worktree is that session's folder, so it is the root; the project's name still
    // labels it, the way a session started from a worktree's submenu is labelled
    // (see `foldersOf` in menus.ts).
    if (!from?.projectPath) {
      toastError("Couldn't open an editor pane", 'the session it came from has no folder')
      return null
    }
    try {
      target = await window.terminator.createSession({
        kind: 'editor',
        mode: 'normal',
        projectName: from.projectName,
        projectPath: from.worktreePath || from.projectPath,
        ...(from.runtime ? { runtime: from.runtime } : {}),
      })
    } catch (e) {
      toastError("Couldn't open an editor pane", String(e).slice(0, 200))
      return null
    }
    useStore.getState().upsert(target)
  }

  useStore.getState().openSession(target.id)
  return target
}

/**
 * Open a file a session printed in an in-app Editor pane, making one if there isn't
 * one yet.
 *
 * It used to be the end of it that no pane covered the file: no open, just a toast
 * telling you to go and make one. But a clicked *link* never asked that —
 * `openInAppBrowser` above creates the pane it needs — and there is no reason a file
 * should be the harder of the two.
 *
 * `token` is whatever was on screen — relative, `~`-prefixed or absolute. It is
 * resolved through main against the printing session's own folder, which is the same
 * boundary the editor itself enforces, so nothing here can reach a file that session
 * couldn't. Callers with an already-absolute path lose nothing by it.
 */
export async function openInPane(sessionId: string, token: string, line?: number): Promise<void> {
  let resolved: string | null = null
  try {
    resolved = await window.terminator.resolveOutputPath(sessionId, token)
  } catch {
    resolved = null
  }
  if (!resolved) {
    toastError("Couldn't open that file", `${token} isn't inside that session's folder`)
    return
  }
  // Bound to a const so the closure below keeps the narrowing.
  const path = resolved

  const target = await ensureEditorPane(sessionId, (root) => within(root, path))
  if (!target) return
  // Works on a pane that hasn't mounted yet: the file read resolves its root in main
  // from the session id, and the editor store makes a session's state on first touch.
  await editors.openFile(target.id, path, baseName(path))
  if (line) editors.revealLine(target.id, path, line)
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

/** What a plain click does: whichever of the two you made the default. */
export function openFileTarget(target: Extract<LinkTarget, { kind: 'file' }>): void {
  if (inAppEditorIsDefault()) void openInPane(target.sessionId, target.path, target.line)
  else void openExternally(target)
}

function open(target: LinkTarget, browserId?: string): void {
  if (target.kind === 'web') void openWeb(target.url, browserId, target.sessionId)
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
    // Three readings, because there are three situations: no program configured, one
    // configured and chosen, one configured but the pane chosen. The middle line is
    // the only one that can name the program as the destination.
    return {
      text: target.label,
      sub: !editor
        ? 'Click to open in an editor pane · right-click for more'
        : inAppEditorIsDefault()
          ? `Click to open in an editor pane · right-click for ${editor}`
          : `Click to open in ${editor} · right-click for an editor pane`,
    }
  }
  const browser = defaultTarget()
  const where = browser ? browser.name : 'your default browser'
  // The in-app row and the system-default row always exist, so there is always
  // somewhere else to send it — no need to work out whether the menu is worth it.
  return { text: target.url, sub: `Click to open in ${where} · right-click for others` }
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
  // `enabled` governs links in *terminal output*, so the check belongs to this
  // entry point and not to the shared body below — a link in a transcript isn't
  // terminal output, and turning that setting off shouldn't silently break its menu.
  if (!settings.enabled || !hovered) return false
  return openMenuForTarget(ev, hovered)
}

/** The same menu, for a target the caller already has (a rendered markdown link). */
export function openMenuForTarget(ev: MouseEvent, target: LinkTarget): boolean {
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
    // First, because it's the one that doesn't leave the app.
    el.appendChild(
      menuItem(
        `Open in ${IN_APP_BROWSER_NAME}`,
        settings.defaultBrowserId === IN_APP_BROWSER_ID ? 'default' : undefined,
        () => void openWeb(target.url, IN_APP_BROWSER_ID, target.sessionId),
      ),
    )
    for (const b of settings.browsers) {
      el.appendChild(
        menuItem(
          `Open in ${b.name}`,
          b.id === settings.defaultBrowserId ? 'default' : undefined,
          () => void openWeb(target.url, b.id, target.sessionId),
        ),
      )
    }
    el.appendChild(
      menuItem(
        'Open in system default',
        settings.defaultBrowserId ? undefined : 'default',
        // '' asks for no configured browser, whatever the default is set to.
        () => void openWeb(target.url, '', target.sessionId),
      ),
    )
    el.appendChild(
      menuItem('Copy link', undefined, () => window.terminator.clipboardWrite(target.url)),
    )
  } else {
    const editor = externalEditor()
    const inApp = inAppEditorIsDefault()
    if (editor) {
      el.appendChild(
        menuItem(`Open in ${editor}`, inApp ? undefined : 'default', () =>
          void openExternally(target),
        ),
      )
    }
    el.appendChild(
      menuItem('Open in editor pane', inApp ? 'default' : undefined, () =>
        void openInPane(target.sessionId, target.path, target.line),
      ),
    )
    el.appendChild(
      // The path the session itself printed — a WSL session's Linux one, not the share.
      menuItem('Copy path', undefined, () =>
        window.terminator.clipboardWrite(parseWslUnc(target.path)?.linux ?? target.path),
      ),
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
        links.push(makeLink(term, range, url, { kind: 'web', url, sessionId }))
      }

      if (!settings.openFilePaths) {
        callback(links)
        return
      }

      // One entry per *file*, not per match: `a/b.{h,cpp}` is one match naming two,
      // each with its own span. Expanding here rather than after the stats is what
      // keeps this array 1:1 with the results below.
      const candidates: {
        path: string
        line?: number
        column?: number
        start: number
        end: number
        label: string
      }[] = []
      for (const m of group.text.matchAll(PATH_RE)) {
        if (m.index === undefined) continue
        const start = m.index
        const end = start + m[0].length - 1
        // Skip anything inside a URL we already matched (its host and path). Whole
        // match, before expanding: an alternative can't be outside its own token.
        if (taken.some(([a, b]) => start <= b && end >= a)) continue
        for (const e of expandBraces(m[0])) {
          if (!looksLikePath(e.path)) continue
          const { path, line, column } = splitLine(e.path)
          candidates.push({
            path,
            line,
            column,
            start: start + e.from,
            end: start + e.to,
            // What the hover names. For a brace alternative that is the expanded path
            // rather than the one character underlined, which is the whole point of
            // underlining it: `h` on its own says nothing about which file it opens.
            label: e.path,
          })
        }
      }
      if (!candidates.length) {
        callback(links)
        return
      }

      void Promise.all(
        candidates.map((c) =>
          window.terminator.resolveOutputPath(sessionId, c.path).catch(() => null),
        ),
      ).then((resolved) => {
        resolved.forEach((abs, i) => {
          if (!abs) return
          const c = candidates[i]
          const range = rangeFor(group, c.start, c.end)
          if (!range) return
          links.push(
            makeLink(term, range, group.text.slice(c.start, c.end + 1), {
              kind: 'file',
              sessionId,
              path: abs,
              line: c.line,
              column: c.column,
              label: c.label,
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
export function oscLinkHandler(sessionId: string, term: Terminal): ILinkHandler {
  return {
    allowNonHttpProtocols: false,
    activate: (ev, text) => {
      if (!settings.enabled || !wasRealClick(term, ev)) return
      hideTooltip()
      void openWeb(text, undefined, sessionId)
    },
    hover: (ev, text) => {
      hovered = { kind: 'web', url: text, sessionId }
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
