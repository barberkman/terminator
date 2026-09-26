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

import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionRuntime, TranscriptPrompt } from '../shared/types'
import { isWsl, linuxToHost } from '../shared/wsl-path'
import { expandHome } from './pty-manager'
import { readyProbe } from './wsl'

/** One parsed transcript line. The format is Claude's, so nothing is assumed. */
export type Record_ = Record<string, unknown>

/** The folder name Claude files a working directory's transcripts under. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Where a Windows session's transcripts live: the Windows user's ~/.claude. */
export function windowsTranscriptDir(cwd: string): string {
  const abs = expandHome(cwd) || cwd
  return join(homedir(), '.claude', 'projects', encodeCwd(abs))
}

/**
 * The directory Claude keeps a working directory's transcripts in, for a session
 * running in `runtime`. A WSL session's Claude is a Linux program: it keeps them
 * under the *distro* user's config folder, keyed by the Linux cwd, and this process
 * reaches that folder through the distro's UNC share.
 */
export async function transcriptDirFor(
  runtime: SessionRuntime | undefined,
  cwd: string,
): Promise<string> {
  if (!runtime || !isWsl({ runtime })) return windowsTranscriptDir(cwd)
  const p = await readyProbe(runtime.distro)
  return linuxToHost(p.distro, `${p.claudeDir}/projects/${encodeCwd(cwd)}`)
}

export function transcriptFile(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.jsonl`)
}

/**
 * Whether Claude already has a saved conversation for this session id in that
 * folder. Ground truth for --resume vs --session-id: an in-memory flag can't know
 * it for sessions restored across an app restart. Synchronous, for the Windows
 * launch path, which reaches its pty without awaiting anything.
 */
export function hasTranscript(dir: string, sessionId: string): boolean {
  return existsSync(transcriptFile(dir, sessionId))
}

/** `hasTranscript` without blocking — a WSL share can take seconds to answer. */
export async function transcriptExists(dir: string, sessionId: string): Promise<boolean> {
  try {
    await fsp.access(transcriptFile(dir, sessionId))
    return true
  } catch {
    return false
  }
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
export function promptText(rec: Record_): string {
  const msg = rec.message as { role?: string; content?: unknown } | undefined
  if (!msg || msg.role !== 'user') return ''
  const c = msg.content
  if (typeof c === 'string') return c
  // Content blocks: keep it a prompt only if every block is something a person
  // can send. A `tool_result` isn't, and disqualifies the whole record.
  if (!Array.isArray(c)) return ''
  const texts: string[] = []
  for (const block of c) {
    if (!block || typeof block !== 'object') return ''
    const b = block as { type?: string; text?: string }
    // An image *is* part of a human prompt — an attached screenshot rides along
    // beside the words, and Claude leaves an `[Image #1]` marker in the text for
    // it. Bailing here used to drop the whole message from the conversation, so
    // sending a picture meant watching your own prompt never appear.
    if (b.type === 'image') continue
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
export function isHumanPrompt(rec: Record_): boolean {
  if (rec.type !== 'user' || rec.isSidechain === true || rec.isMeta === true) return false
  if (rec.toolUseResult !== undefined) return false
  const origin = rec.origin as { kind?: string } | undefined
  if (origin?.kind && origin.kind !== 'human') return false
  const text = promptText(rec)
  return text.trim() !== '' && !text.startsWith('<command-') && !text.startsWith('<local-command')
}

/** Every prompt the user typed in a session, oldest first. Empty if unreadable. */
export async function listPrompts(dir: string, sessionId: string): Promise<TranscriptPrompt[]> {
  let raw: string
  try {
    raw = await fsp.readFile(transcriptFile(dir, sessionId), 'utf8')
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
  /** The parent's transcript folder (see `transcriptDirFor`). */
  parentDir: string
  parentCwd: string
  newSessionId: string
  /** Where the branch's transcript goes — in the same runtime as the parent's. */
  newDir: string
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
export async function forkTranscript(
  input: ForkInput,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let raw: string
  try {
    raw = await fsp.readFile(transcriptFile(input.parentDir, input.parentSessionId), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'the parent session has no saved conversation yet' }
    }
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

  const dest = transcriptFile(input.newDir, input.newSessionId)
  if (await transcriptExists(input.newDir, input.newSessionId)) {
    return { ok: false, reason: 'a conversation already exists for the new session id' }
  }
  try {
    await fsp.mkdir(input.newDir, { recursive: true })
    // Same atomic write as persistence.ts: a half-written transcript would make
    // Claude refuse to resume.
    const tmp = `${dest}.${process.pid}.tmp`
    await fsp.writeFile(tmp, `${out.join('\n')}\n`, 'utf8')
    await fsp.rename(tmp, dest)
  } catch (e) {
    return { ok: false, reason: `couldn't write the branch transcript: ${String(e).slice(0, 120)}` }
  }
  return { ok: true }
}
