// Reading and forking Claude Code's conversation transcripts.
//
// Claude stores one JSONL file per session at
// ~/.claude/projects/<cwd-with-nonalnum-as-dash>/<session-id>.jsonl, one record
// per line, chained through `parentUuid`. Branching a chat means seeding a new
// transcript: copy the parent's file up to the chosen cut, rewrite the ids inside,
// and let the launcher start it with `--resume <newId>` (session-launcher.ts
// already picks --resume over --session-id whenever a transcript exists on disk).
//
// Why not `claude --resume <id> --fork-session`? It mints a *random* new session
// id, and this app's whole status pipeline maps hook payloads by session_id
// (report-server.ts) — Terminator's session id and Claude's must stay equal. If
// the seeding approach ever stops working, the fallback is that flag plus learning
// the new id from the first hook payload, which means decoupling the two ids
// across state.ts, report-server.ts and hooks-config.ts.
//
// The format is Claude's private storage, not a public API, so everything here is
// defensive: unknown record types are copied through untouched, unparseable lines
// are skipped (the parent may be mid-write), and the parent file is never modified.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptPrompt } from '../shared/types'
import { expandHome } from './pty-manager'

type Record_ = Record<string, unknown>

/** The directory Claude keeps a working directory's transcripts in. */
function transcriptDir(cwd: string): string {
  const abs = expandHome(cwd) || cwd
  return join(homedir(), '.claude', 'projects', abs.replace(/[^a-zA-Z0-9]/g, '-'))
}

export function transcriptPath(sessionId: string, cwd: string): string {
  return join(transcriptDir(cwd), `${sessionId}.jsonl`)
}

/**
 * Whether Claude already has a saved conversation for this session id in cwd's
 * project. Ground truth for --resume vs --session-id: an in-memory flag can't
 * know it for sessions restored across an app restart.
 */
export function hasTranscript(sessionId: string, cwd: string): boolean {
  return existsSync(transcriptPath(sessionId, cwd))
}

function parseLines(raw: string): (Record_ | null)[] {
  return raw.split('\n').map((line) => {
    if (!line.trim()) return null
    try {
      return JSON.parse(line) as Record_
    } catch {
      // A half-written trailing line while the parent session is live.
      return null
    }
  })
}

/** The plain text of a user record, or '' if it isn't plain text. */
function promptText(rec: Record_): string {
  const msg = rec.message as { role?: string; content?: unknown } | undefined
  if (!msg || msg.role !== 'user') return ''
  const c = msg.content
  if (typeof c === 'string') return c
  // Content blocks: keep it a prompt only if it's purely text (tool results aren't).
  if (!Array.isArray(c)) return ''
  const texts: string[] = []
  for (const block of c) {
    if (!block || typeof block !== 'object') return ''
    const b = block as { type?: string; text?: string }
    if (b.type !== 'text' || typeof b.text !== 'string') return ''
    texts.push(b.text)
  }
  return texts.join('\n')
}

/**
 * Records the user actually typed: not sidechain (subagent) traffic, not tool
 * results, not the `<command-name>`/`<local-command-stdout>` envelopes Claude
 * writes for slash commands. `origin.kind` is the reliable marker in current
 * versions; the shape checks keep this working if that field ever moves.
 */
function isHumanPrompt(rec: Record_): boolean {
  if (rec.type !== 'user' || rec.isSidechain === true || rec.isMeta === true) return false
  if (rec.toolUseResult !== undefined) return false
  const origin = rec.origin as { kind?: string } | undefined
  if (origin?.kind && origin.kind !== 'human') return false
  const text = promptText(rec)
  return text.trim() !== '' && !text.startsWith('<command-') && !text.startsWith('<local-command')
}

/** Every prompt the user typed in a session, oldest first. Empty if unreadable. */
export function listPrompts(sessionId: string, cwd: string): TranscriptPrompt[] {
  const file = transcriptPath(sessionId, cwd)
  if (!existsSync(file)) return []
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: TranscriptPrompt[] = []
  for (const rec of parseLines(raw)) {
    if (!rec || !isHumanPrompt(rec) || typeof rec.uuid !== 'string') continue
    out.push({
      index: out.length + 1,
      uuid: rec.uuid,
      text: promptText(rec),
      timestamp: typeof rec.timestamp === 'string' ? rec.timestamp : '',
    })
  }
  return out
}

export interface ForkInput {
  parentSessionId: string
  parentCwd: string
  newSessionId: string
  newCwd: string
  /** uuid of the first prompt to leave behind; null copies the whole transcript. */
  cutBeforeUuid: string | null
}

/**
 * Seed `newSessionId`'s transcript from `parentSessionId`'s, keeping everything
 * before the cut. The cut is a *gap between prompts*, named by the prompt that
 * follows it — so line-granular copying is enough and the prefix is always a
 * structurally valid transcript (no need to walk the parentUuid chain).
 * The parent file is only ever read.
 */
export function forkTranscript(input: ForkInput): { ok: true } | { ok: false; reason: string } {
  const src = transcriptPath(input.parentSessionId, input.parentCwd)
  if (!existsSync(src)) return { ok: false, reason: 'the parent session has no saved conversation yet' }
  let raw: string
  try {
    raw = readFileSync(src, 'utf8')
  } catch {
    return { ok: false, reason: "couldn't read the parent transcript" }
  }

  const records = parseLines(raw)
  let cut = records.length
  if (input.cutBeforeUuid) {
    const at = records.findIndex((r) => r && r.uuid === input.cutBeforeUuid)
    if (at < 0) return { ok: false, reason: 'that prompt is no longer in the transcript' }
    cut = at
  }

  const sameCwd = (expandHome(input.parentCwd) || input.parentCwd) === (expandHome(input.newCwd) || input.newCwd)
  const kept = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < cut; i++) {
    const rec = records[i]
    if (!rec) continue
    // Transient bookkeeping about a prompt that is in flight, not conversation.
    if (rec.type === 'queue-operation') continue
    // Pointers into the conversation are only valid if their target survived the cut.
    if (typeof rec.leafUuid === 'string' && !kept.has(rec.leafUuid)) continue
    if (typeof rec.uuid === 'string') kept.add(rec.uuid)
    const next: Record_ = { ...rec }
    if (typeof next.sessionId === 'string') next.sessionId = input.newSessionId
    if (!sameCwd && typeof next.cwd === 'string') next.cwd = input.newCwd
    out.push(JSON.stringify(next))
  }
  if (!out.length) return { ok: false, reason: 'nothing to branch from — the transcript is empty' }

  const dest = transcriptPath(input.newSessionId, input.newCwd)
  if (existsSync(dest)) return { ok: false, reason: 'a conversation already exists for the new session id' }
  try {
    mkdirSync(transcriptDir(input.newCwd), { recursive: true })
    // Same atomic write as persistence.ts: a half-written transcript would make
    // Claude refuse to resume.
    const tmp = `${dest}.${process.pid}.tmp`
    writeFileSync(tmp, `${out.join('\n')}\n`, 'utf8')
    renameSync(tmp, dest)
  } catch (e) {
    return { ok: false, reason: `couldn't write the branch transcript: ${String(e).slice(0, 120)}` }
  }
  return { ok: true }
}
