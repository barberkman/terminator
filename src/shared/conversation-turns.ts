// A conversation read as turns, and a sent prompt matched against what arrived.
//
// Shared by the conversation view and the scripting commands in main, because both
// answer the same two questions — "what did Claude say in this turn" (Copy reply,
// `terminator reply`) and "has the prompt we typed in turned up yet" (the composer's
// pending item, `terminator wait`) — and two answers to either would drift.

import type { ConversationItem } from './types'

/**
 * How long a sent prompt may go unseen before nobody claims it's on its way any
 * more. Only *quiet* time counts — time the session spent not working — so this is
 * 20 seconds of a session with nothing to do: a long way past the second or so a
 * send normally takes, and unreachable while Claude is busy with an earlier turn.
 */
export const PENDING_UNSURE_MS = 20_000

/** Clock slop between this app stamping a send and Claude stamping the record. */
const TS_SLACK_MS = 5_000

/** One exchange: a prompt (when there is one) and everything Claude did after it. */
export interface Turn {
  key: string
  prompt?: Extract<ConversationItem, { kind: 'prompt' }>
  body: ConversationItem[]
}

export function toTurns(items: ConversationItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  for (const item of items) {
    if (item.kind === 'prompt') {
      current = { key: item.id, prompt: item, body: [] }
      turns.push(current)
      continue
    }
    // A resumed or branched session opens mid-conversation: hold the replies that
    // arrive before the first prompt rather than dropping them.
    if (!current) {
      current = { key: `pre-${item.id}`, body: [] }
      turns.push(current)
    }
    current.body.push(item)
  }
  return turns
}

/** Everything Claude said in prose in this turn — the "copy the whole answer" text. */
export function replyText(turn: Turn): string {
  return turn.body
    .filter((i) => i.kind === 'text')
    .map((i) => i.text)
    .join('\n\n')
}

/** What `reconcile` needs to know about a prompt that was sent. */
export interface SentPrompt {
  /** Ours, never a transcript uuid — these have no id until they land. */
  key: string
  /** Exactly what `sendPrompt` wrote. */
  text: string
  /** The typed message alone, when attachment paths were folded in front of it. */
  message?: string
  sentAt: number
}

/**
 * How a sent prompt and a transcript record are compared. Whitespace is
 * collapsed because the TUI re-flows what it is given (tabs become its own tab
 * stops), so insisting on the bytes would leave a prompt pending forever.
 */
export function norm(text: string): string {
  return unwrapPasted(text).replace(/\s+/g, ' ').trim()
}

const PASTED = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content(?: id="\1")?>/g

/**
 * A prompt as typed, without the wrapper Claude (2.1.310 on) records a pasted one
 * in: `\n\n<pasted_content id="…">\n…\n</pasted_content id="…">\n`. The composer
 * sends by bracketed paste, so every prompt it sends can come back wrapped — and
 * wrapped, it neither matches the text we sent nor reads as what you wrote.
 */
export function unwrapPasted(text: string): string {
  const out = text.replace(PASTED, '$2')
  return out === text ? text : out.trim()
}

/**
 * Retire the sent prompts that have turned up.
 *
 * Matching is by text, because a prompt has no id until Claude writes one. Two
 * guards keep that honest: only records stamped at or after the send can match
 * (so an identical prompt from an hour ago can't retire a fresh one), and each
 * record is claimed once (so two identical messages sent back to back resolve
 * against two records rather than both against the first).
 *
 * Three sweeps, strictest first:
 *   1. exact — the ordinary case.
 *   2. prefix — `promptText` joins every text block of a user record, so our text
 *      can legitimately be a prefix. Taken after exact so "go" can't eat the
 *      record belonging to "go on".
 *   3. contains, message only — the TUI rewrites an image path it recognises into
 *      `[Image #1]`, so a prompt sent with an attachment is *not* what lands in
 *      the transcript. The typed words survive; the path doesn't. Loose enough to
 *      need the two guards above, which is why it runs last and only for pendings
 *      that actually carried an attachment.
 *
 * Returns the same array when nothing matched, so an idle tick writes nothing.
 */
export function reconcile<T extends SentPrompt>(arrived: ConversationItem[], pendings: T[]): T[] {
  const prompts = arrived.filter((i) => i.kind === 'prompt')
  if (!prompts.length) return pendings
  const claimed = new Set<string>()
  const retired = new Set<string>()

  const sweep = (how: 'exact' | 'prefix' | 'message'): void => {
    for (const p of pendings) {
      if (retired.has(p.key)) continue
      const want = norm(how === 'message' ? (p.message ?? '') : p.text)
      if (!want) continue
      const hit = prompts.find((c) => {
        if (claimed.has(c.id)) return false
        const at = Date.parse(c.ts)
        if (!Number.isNaN(at) && at < p.sentAt - TS_SLACK_MS) return false
        const got = norm(c.text)
        if (how === 'exact') return got === want
        if (how === 'prefix') return got.startsWith(want)
        return got.includes(want)
      })
      if (!hit) continue
      claimed.add(hit.id)
      retired.add(p.key)
    }
  }
  sweep('exact')
  sweep('prefix')
  sweep('message')

  return retired.size ? pendings.filter((p) => !retired.has(p.key)) : pendings
}
