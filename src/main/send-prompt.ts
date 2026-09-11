// Submitting a prompt to a running Claude session from the conversation view.
//
// The TUI owns the real input box, so "send" means *typing into the pty* — the
// same mechanism prefill.ts and attachments.ts use, plus the Enter they
// deliberately never press. That difference is the whole reason this is its own
// module: prefill's promise is "type it, never submit it", and a submitting path
// living in the same file would give one module two opposite contracts.
//
// It also makes sanitising load-bearing rather than cosmetic. In prefill, a stray
// escape sequence in the text ends the bracketed paste early and leaves visible
// junk in a box the user then looks at. Here the same sequence is followed by
// Enter, so whatever the escape hatch left behind gets submitted — or read as
// menu keystrokes by whatever the TUI shows next. See `sanitise`.

import type { SendPromptResult } from '../shared/types'
import * as ptyMgr from './pty-manager'
import { getSession } from './state'

/**
 * Longer than this is refused, not truncated. Truncating would silently send a
 * *different* prompt than the one the composer shows as sent, and the point of
 * that pending item is that what you see is what went.
 */
const MAX_PROMPT_CHARS = 100_000

/**
 * What may cross into a bracketed paste that is about to be followed by Enter.
 *
 * The paste wrapper is not a sandbox: a literal `ESC[201~` inside the text ends
 * the paste early, and everything after it is read as *keystrokes* by a TUI that
 * treats letters and arrows as menu selections — and then we press Enter on
 * whatever that left behind. So no ESC at all (which kills `201~` along with
 * every other CSI), no 8-bit C1 (U+0080–U+009F decodes to CSI in some parsers),
 * and no C0 control except the newline that is text.
 *
 * `\r` is folded into `\n` *before* the strip rather than swallowed by it, so a
 * prompt pasted from a Windows clipboard keeps its line breaks. Tabs fold to a
 * space because Claude's input box expands them to its own tab stops — keeping
 * the tab would mean the transcript never matches the text we sent, and that
 * match is how the conversation view retires a pending prompt.
 *
 * Nothing here is shell quoting: these bytes go to a pty, not to a shell, and
 * backticks, `$` and quotes are ordinary characters in Claude's input box.
 */
function sanitise(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, ' ')
      // Every C0 control except \n (\x0a), ESC included, plus DEL and 8-bit C1.
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\u009f]/g, '')
      .replace(/ +$/gm, '')
      .trim()
  )
}

/**
 * Type a prompt into a Claude session and press Enter.
 *
 * The paste and the carriage return go out as **one** write. Measured against
 * claude 2.1.268 (four runs, ground truth read from the session's own transcript
 * rather than from the painted screen): a combined `ESC[200~ … ESC[201~\r`
 * submitted the whole multi-line prompt as a single `user` record every time.
 * Splitting them with a timer was the alternative, and it buys a race — a pty id
 * is reused across a relaunch, so a late `\r` could land in a different Claude
 * than the paste did. One write has no such window. If Claude's input handling
 * ever changes, this is the line to re-measure.
 *
 * `ok` means "handed to the pty", not "Claude has it": nothing comes back up the
 * pty to confirm a prompt was accepted. The transcript is the only real receipt,
 * which is why the renderer holds a pending item until the prompt turns up there
 * — and why this returns the exact text it wrote, so the two can be compared.
 */
export function sendPrompt(id: string, raw: string): SendPromptResult {
  const s = getSession(id)
  if (!s) return { ok: false, reason: 'that session is gone' }
  if (s.kind !== 'claude') return { ok: false, reason: 'only a Claude session takes a prompt' }
  if (!s.alive) return { ok: false, reason: `${s.name} isn't running — relaunch it first` }
  // Re-checked here even though the composer greys itself out for `waiting`: the
  // status can flip between the render and the keystroke (Claude raises a
  // permission dialog while you're mid-sentence). Those dialogs read a paste as
  // menu input, so the renderer's disabled send is the courtesy and this is the
  // guarantee. `busy` is deliberately allowed — Claude queues what arrives
  // mid-turn, which is the whole point of being able to type ahead.
  if (s.status === 'waiting') {
    return {
      ok: false,
      reason: `${s.name} is waiting on something in its terminal — answer that first`,
    }
  }

  const text = sanitise(raw)
  if (!text) return { ok: false, reason: 'nothing to send' }
  if (text.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      reason: `that's ${text.length.toLocaleString()} characters — too long to type in`,
    }
  }

  ptyMgr.writePty(id, `\x1b[200~${text}\x1b[201~\r`)
  return { ok: true, text }
}
