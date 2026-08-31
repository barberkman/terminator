// A prompt queued for a freshly branched session's input box.
//
// Branching "before prompt N" exists so you can ask N differently, so the modal
// can hand the original text over as an editable draft. It can only be typed once
// Claude's TUI is actually up, which the SessionStart hook tells us
// (report-server.ts) — nothing else in the app knows when a Claude session is ready.

import * as ptyMgr from './pty-manager'

const pending = new Map<string, string>()

export function setPendingPrompt(id: string, text: string): void {
  if (text.trim()) pending.set(id, text)
}

export function cancelPendingPrompt(id: string): void {
  pending.delete(id)
}

/**
 * Type the queued prompt into the session without sending it. Wrapped in
 * bracketed paste (ESC[200~ … ESC[201~) so a multi-line prompt lands as one
 * editable draft instead of submitting itself at the first newline.
 */
export function flushPendingPrompt(id: string): void {
  const text = pending.get(id)
  if (text === undefined) return
  pending.delete(id)
  // SessionStart fires before the input box has painted; give it a beat.
  setTimeout(() => ptyMgr.writePty(id, `\x1b[200~${text}\x1b[201~`), 500)
}
