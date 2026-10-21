// Two things about a Claude session that its status dot can't say, kept for the
// `terminator` command (scripting.ts):
//
//   • Whether its TUI is up. The launcher marks a Windows session `ready` the
//     moment it spawns, long before Claude has drawn an input box, so a prompt typed
//     straight after `terminator new` would land nowhere. SessionStart is the only
//     real signal (report-server.ts), the same one a branch's draft waits for.
//
//   • Whether a prompt a script typed in has become a turn yet. Until it has, the
//     session's `idle` is still about the turn *before* it — and `terminator wait`
//     straight after `send` must not take that for the answer. A prompt is matched
//     to the turn it started by its text, with the composer's own rules
//     (shared/conversation-turns.ts), so a prompt you typed yourself in the
//     meantime can't be mistaken for the script's.

import { promises as fsp } from 'node:fs'
import { PENDING_UNSURE_MS, reconcile, type SentPrompt } from '../shared/conversation-turns'
import type { ConversationItem, SessionStatus } from '../shared/types'
import { readConversation } from './conversation'
import * as ptyMgr from './pty-manager'
import { getSession, onSessionChange } from './state'
import { conversationFile } from './transcript'

/** The pty generation whose Claude said it was up, and when. */
const ready = new Map<string, { gen: number; at: number }>()

interface Scripted extends SentPrompt {
  /** Transcript size when it was sent — the backstop reads from here. */
  offset: number
  /** Settled time spent waiting for it; see `tick`. */
  quietMs: number
  /** The session has gone *into* working since this was sent: a turn has run. */
  turnSeen: boolean
}
const pending = new Map<string, Scripted[]>()
/** Per session: when the latest scripted prompt was sent, and when one was last given up on. */
const lastSent = new Map<string, number>()
const gaveUp = new Map<string, number>()
/** The status each session was last seen in, so a move into busy can be told from busy carrying on. */
const lastStatus = new Map<string, SessionStatus>()

type Listener = (id: string) => void
const listeners = new Set<Listener>()

/** Hear when a session becomes ready, or a scripted prompt is taken or given up on. */
export function onTurnChange(cb: Listener): void {
  listeners.add(cb)
}

function changed(id: string): void {
  for (const l of [...listeners]) l(id)
}

/** SessionStart from the session's current Claude. */
export function claudeReady(id: string): void {
  ready.set(id, { gen: ptyMgr.ptyGeneration(id), at: Date.now() })
  changed(id)
}

/** When the running Claude said it was up, or undefined while it hasn't (or isn't running). */
export function readySince(id: string): number | undefined {
  const r = ready.get(id)
  return r && getSession(id)?.alive && r.gen === ptyMgr.ptyGeneration(id) ? r.at : undefined
}

let nextKey = 1

/**
 * A script just typed `text` in. `offset` is how long the transcript was before
 * it, so the backstop below only looks at what came after.
 */
export function addScriptedPrompt(id: string, text: string, offset: number): void {
  const now = Date.now()
  pending.set(id, [
    ...(pending.get(id) ?? []),
    { key: `s${nextKey++}`, text, sentAt: now, offset, quietMs: 0, turnSeen: false },
  ])
  lastSent.set(id, now)
  if (!ticker) ticker = setInterval(() => void tick(), TICK_MS)
  changed(id)
}

/** Whether a prompt a script sent hasn't been taken as a turn yet. */
export function hasScriptedPrompt(id: string): boolean {
  return !!pending.get(id)?.length
}

/** Whether the latest prompt a script sent was given up on rather than seen. */
export function lastPromptGivenUp(id: string): boolean {
  return (gaveUp.get(id) ?? 0) >= (lastSent.get(id) ?? Infinity)
}

/**
 * UserPromptSubmit: Claude took a prompt. Retire the scripted one it was, if any.
 * Called ahead of report-server's ordering checks, because a submit delivered
 * after its own Stop is late, not stale — it is still the receipt.
 */
export function promptSubmitted(id: string, text: string): void {
  const list = pending.get(id)
  if (!list?.length || !text) return
  const item: ConversationItem = { kind: 'prompt', id: `hook-${nextKey++}`, ts: new Date().toISOString(), text }
  settle(id, reconcile([item], list))
}

function settle(id: string, left: Scripted[]): void {
  if (left === pending.get(id)) return
  if (left.length) pending.set(id, left)
  else pending.delete(id)
  changed(id)
}

function forget(id: string): void {
  ready.delete(id)
  if (pending.delete(id)) changed(id)
}

// ---- the backstop -------------------------------------------------------------
//
// The hook is how a prompt is normally seen, but it is one HTTP post that can fail
// on its own (the reporter gives up after 1.5s). So while a scripted prompt is
// outstanding and the session has settled, the transcript is read from where it
// stood at the send — the same check the composer's pending item makes — but only
// once the session has gone into working since: Claude writes the prompt down the
// moment it takes it, a beat before its first tool call says it's busy, and in that
// beat an idle status is still the turn before's. And a
// prompt that never becomes a turn of its own (a slash command, or one Claude folds
// into a turn already running) is let go after the composer's 20 seconds of settled
// quiet, so `wait` can't hang on it forever. Only `idle` and `error` count as
// settled: a session blocked on a dialog with the prompt queued behind it is still
// on its way to that prompt.

const TICK_MS = 2_000
let ticker: NodeJS.Timeout | null = null
let ticking = false

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    for (const id of [...pending.keys()]) {
      const s = getSession(id)
      if (!s) {
        forget(id)
        continue
      }
      if (s.status !== 'idle' && s.status !== 'error') continue
      const list = pending.get(id)
      if (!list?.length) continue
      const ran = list.filter((p) => p.turnSeen)
      const file = ran.length ? await conversationFile(s) : null
      if (file) {
        const slice = await readConversation(file, Math.min(...ran.map((p) => p.offset)))
        const now = pending.get(id)
        const eligible = now?.filter((p) => p.turnSeen) ?? []
        const left = reconcile(slice.items, eligible)
        if (now && left !== eligible) settle(id, now.filter((p) => !p.turnSeen || left.includes(p)))
      }
      const left = pending.get(id)
      if (!left?.length) continue
      const aged = left.map((p) => ({ ...p, quietMs: p.quietMs + TICK_MS }))
      const kept = aged.filter((p) => p.quietMs < PENDING_UNSURE_MS)
      if (kept.length < aged.length) {
        gaveUp.set(id, Date.now())
        settle(id, kept)
      } else {
        pending.set(id, kept)
      }
    }
  } finally {
    ticking = false
    if (!pending.size && ticker) {
      clearInterval(ticker)
      ticker = null
    }
  }
}

/** The size of a transcript right now, or 0 when there isn't one yet. */
export async function transcriptSize(file: string | null): Promise<number> {
  if (!file) return 0
  try {
    return (await fsp.stat(file)).size
  } catch {
    return 0
  }
}

/**
 * A process that exits takes its readiness and its outstanding prompts with it. A
 * move into working is a turn running: it restarts the quiet clock, and opens the
 * transcript backstop to the prompts sent before it.
 */
export function wireClaudeTurns(): void {
  ptyMgr.onExit((id) => forget(id))
  onSessionChange((id, s) => {
    if (!s) {
      forget(id)
      lastStatus.delete(id)
      return
    }
    const was = lastStatus.get(id)
    lastStatus.set(id, s.status)
    const list = pending.get(id)
    if (list && s.status === 'busy' && was !== 'busy') {
      pending.set(id, list.map((p) => ({ ...p, quietMs: 0, turnSeen: true })))
    }
  })
}
