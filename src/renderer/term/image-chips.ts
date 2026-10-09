import type { IDisposable, Terminal } from '@xterm/xterm'

// `[Image #N]` in a Claude pane → the image it stands for.
//
// Pasting an image into a Claude pane types the file's path into the prompt, and
// Claude swaps that path for an `[Image #N]` chip. The chip is all that's left of
// the paste on screen, so it's the natural thing to click to see the image again,
// but nothing on screen says which file it is. Claude can say so itself (an OSC 8
// link, when it thinks the terminal takes them), but only on a message already
// sent, never on the chip still sitting in the prompt box, which is exactly when
// you want to check you pasted the right thing.
//
// N is Claude's, not ours: one counter per conversation, shared with pasted text,
// so it can't be worked out here. It can be *watched for*. The counter only ever
// counts up, so the chip a paste turns into is numbered above every chip on screen
// before the paste. The floor is read before the path is typed, so a quick echo
// can't land under it, and the first chip to clear it is that paste's.
//
// A chip resolves to the path the attach handed back, so opening one goes through
// main's attachment receipts exactly as the toast does. Nothing here outlives the
// run: like those receipts, a chip only opens for a paste made since the app started.

/** How long a paste waits for Claude to draw its chip before giving up on it. */
const WAIT_MS = 5000

/**
 * Claude's chip, as it draws it in the prompt and in the transcript. A factory, as
 * with `webUrlRe`: a shared global regex would carry `lastIndex` between callers.
 */
export function chipRe(): RegExp {
  return /\[Image #(\d+)\]/g
}

const terms = new Map<string, Terminal>()
/** Per session, chip number → the attached image's path (main's receipt for it). */
const known = new Map<string, Map<number, string>>()
/** Pastes still waiting for their chip, and the highest chip number handed out so far. */
interface Watch {
  last: number
  queue: string[]
  stop: () => void
  extend: () => void
}
/** Per session, one watcher, so two pastes in flight can't both claim the same chip. */
const watching = new Map<string, Watch>()

export function track(sessionId: string, term: Terminal): void {
  terms.set(sessionId, term)
}

export function forget(sessionId: string): void {
  watching.get(sessionId)?.stop()
  terms.delete(sessionId)
  known.delete(sessionId)
}

/** The image a chip stands for, when this run pasted it. */
export function chipPath(sessionId: string, n: number): string | undefined {
  return known.get(sessionId)?.get(n)
}

/**
 * Chip numbers on the terminal's screen: the bottom `rows` of the buffer, which is
 * where Claude's prompt is whatever the viewport is scrolled to. Only the screen,
 * not the scrollback: after `/clear` the count starts again from 1, and an old,
 * higher chip still sitting in the scrollback must not hold the floor above it.
 * A wrapped row continues the one above, so a chip split across the right edge
 * still reads as one.
 */
function chipsOnScreen(term: Terminal): number[] {
  const buf = term.buffer.active
  let text = ''
  for (let y = buf.baseY; y < buf.length; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    text += (line.isWrapped ? '' : '\n') + line.translateToString(false)
  }
  return [...text.matchAll(chipRe())].map((m) => Number(m[1]))
}

/**
 * The number a paste's chip has to clear. Read it *before* typing the path. Null
 * when the session has no terminal to watch.
 */
export function chipFloor(sessionId: string): number | null {
  const term = terms.get(sessionId)
  if (!term) return null
  return Math.max(0, ...chipsOnScreen(term))
}

function remember(sessionId: string, n: number, path: string): void {
  let mine = known.get(sessionId)
  if (!mine) {
    mine = new Map()
    known.set(sessionId, mine)
  }
  // A number that doesn't count up means the conversation started over (`/clear`).
  // This number and every one above it belonged to the old one.
  for (const k of [...mine.keys()]) if (k >= n) mine.delete(k)
  mine.set(n, path)
}

/**
 * Learn which chips a paste became. `floor` is `chipFloor` from before the attach
 * typed anything; `paths` are the images it typed, in order. Claude numbers them in
 * that same order, so new chips are handed out lowest first. A paste whose chip
 * never shows up (Claude didn't take the path as an image) is dropped after
 * `WAIT_MS`, and its chip simply isn't a link.
 */
export function expectChips(sessionId: string, floor: number, paths: string[]): void {
  const term = terms.get(sessionId)
  if (!term || !paths.length) return

  const pending = watching.get(sessionId)
  if (pending) {
    // Already watching for an earlier paste: queue behind it, so the chips are
    // handed out in the order the pastes were typed.
    pending.queue.push(...paths)
    pending.extend()
    return
  }

  const w: Watch = { last: floor, queue: [...paths], stop: () => {}, extend: () => {} }
  let sub: IDisposable | null = null
  let timer = 0
  w.stop = () => {
    sub?.dispose()
    window.clearTimeout(timer)
    if (watching.get(sessionId) === w) watching.delete(sessionId)
  }
  w.extend = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(w.stop, WAIT_MS)
  }
  const look = (): void => {
    const fresh = [...new Set(chipsOnScreen(term))].filter((n) => n > w.last).sort((a, b) => a - b)
    for (const n of fresh) {
      const path = w.queue.shift()
      if (!path) break
      remember(sessionId, n, path)
      w.last = n
    }
    if (!w.queue.length) w.stop()
  }

  watching.set(sessionId, w)
  // Every batch of output Claude paints is a chance the chip just arrived.
  sub = term.onWriteParsed(look)
  w.extend()
  look()
}
