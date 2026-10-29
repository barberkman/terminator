// The `terminator` command's verbs, carried out the way the window carries them out.
//
// Every command here is a UI action, and runs through the code that action runs
// through. When the action is one call into main — Send in the conversation view,
// Stop in the menu, Remove in its dialog — this calls the same function the IPC
// handler does. New Session is the exception: its steps belong to the renderer
// (the dialog builds the request, and the panes are the renderer's), so `new`
// crosses the bridge below and runs the dialog's own sequence there. Nothing in
// this file is a second implementation of something a button already does — that
// is what keeps a script from doing anything the UI can't, and the two from
// drifting apart.
//
// What a script gets on top is waiting, never doing: `send` waits for a starting
// Claude to be ready rather than typing into nothing, and `wait` waits for the turn
// a prompt starts rather than the one before it (claude-turns.ts).

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import { Channels } from '../shared/channels'
import type {
  BridgeNewArgs,
  BridgeReply,
  BridgeRequest,
  ControlCommand,
  ControlFailure,
  ControlRequests,
  ControlResponse,
  ListedSession,
  StatusWord,
} from '../shared/control'
import { replyText, toTurns } from '../shared/conversation-turns'
import { STATUS_LABELS, buildGroups } from '../shared/sidebar'
import { EFFORT_LEVELS, isProcessless, type Session, type SessionStatus } from '../shared/types'
import { parseWslUnc, validRuntime } from '../shared/wsl-path'
import {
  addScriptedPrompt,
  askingTrust,
  hasScriptedPrompt,
  lastPromptGivenUp,
  onTurnChange,
  readySince,
  transcriptSize,
} from './claude-turns'
import { readConversation, readRange } from './conversation'
import { READY_BEAT_MS } from './prefill'
import * as ptyMgr from './pty-manager'
import { SUBMIT_DELAY_MS, sendPrompt, sendRefusal } from './send-prompt'
import { isStarting, reportsStatus, stopSession } from './session-launcher'
import * as state from './state'
import { conversationFile } from './transcript'
import { removeWorktree } from './worktree'

/** How long `send` waits for a starting Claude to say it's up. */
const READY_TIMEOUT_MS = 120_000
/** How long `stop` waits for the process to be gone. */
const STOP_TIMEOUT_MS = 10_000
/** How long a request to the window may take — a worktree on a big repo, a cold WSL distro. */
const BRIDGE_TIMEOUT_MS = 120_000
/** setTimeout's ceiling; anything longer is "no timeout". */
const MAX_DELAY_MS = 2 ** 31 - 1

const STATUS_OF: Record<StatusWord, SessionStatus> = {
  idle: 'idle',
  working: 'busy',
  waiting: 'waiting',
  error: 'error',
  closed: 'closed',
}

function fail(error: string, extra: Omit<ControlFailure, 'ok' | 'error'> = {}): ControlFailure {
  return { ok: false, error, ...extra }
}

function isFail(x: Session | ControlFailure): x is ControlFailure {
  return (x as ControlFailure).ok === false
}

/** The word the status dot carries for a status — "working" for busy. */
function word(status: SessionStatus): StatusWord {
  return STATUS_LABELS[status].toLowerCase() as StatusWord
}

function listed(s: Session): ListedSession {
  const row: ListedSession = {
    id: s.id,
    name: s.name,
    kind: s.kind,
    project: s.projectName,
    branch: s.branch,
    status: word(s.status),
  }
  if (s.kind !== 'claude') return row
  // What the header shows; before Claude's first report, what it was launched with.
  const model = s.metrics?.model ?? s.launchModel
  const effort = s.metrics?.effort ?? s.launchEffort
  return { ...row, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** A model as `--model` and `/model` take it: an alias (`opus`) or a full name (`claude-opus-5-5`, `opus[1m]`). */
const MODEL_NAME = /^[A-Za-z0-9][\w.\-[\]]*$/

/** Why `--model`/`--effort` (or `model`/`effort`) can't take `value`, or null. */
function launchRefusal(what: 'model' | 'effort', value: string): string | null {
  if (what === 'effort') {
    return (EFFORT_LEVELS as readonly string[]).includes(value)
      ? null
      : `effort is one of ${EFFORT_LEVELS.join(', ')}, not ${value || 'nothing'}`
  }
  return MODEL_NAME.test(value) ? null : `${value || 'nothing'} isn't a model name — try fable, opus, sonnet or haiku`
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).trim().slice(0, 300)
}

/** Every session, in the order the sidebar draws them. */
function sidebarOrder(): Session[] {
  const all = state.listSessions()
  const byId = Object.fromEntries(all.map((s) => [s.id, s]))
  return buildGroups(
    all.map((s) => s.id),
    byId,
  ).flatMap((g) => g.sessions)
}

/**
 * A session named by its id, or by `project/name` as the sidebar shows it. A name
 * that matches more than one session is refused rather than guessed at.
 */
function findSession(ref: unknown): Session | ControlFailure {
  if (typeof ref !== 'string' || !ref.trim()) return fail('name a session — its id, or project/name')
  const byId = state.getSession(ref)
  if (byId) return byId
  const hits = sidebarOrder().filter((s) => `${s.projectName}/${s.name}` === ref)
  if (hits.length === 1) return hits[0]
  if (!hits.length) return fail(`there's no session called ${ref}`)
  return fail(`${ref} matches ${hits.length} sessions — name one by its id: ${hits.map((s) => s.id).join(', ')}`)
}

// ---- waiting on a session -----------------------------------------------------

const waiters = new Map<string, Set<() => void>>()

function wake(id: string): void {
  const set = waiters.get(id)
  if (set) for (const f of [...set]) f()
}

/**
 * Resolves on the next change to a session — its status, its process, its turn —
 * or after `ms`, or when the request is dropped. Callers re-read the session and
 * decide again; nothing is passed along, so a missed wake can't mislead one.
 */
function nextChange(id: string, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    let set = waiters.get(id)
    if (!set) waiters.set(id, (set = new Set()))
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      set.delete(finish)
      if (!set.size && waiters.get(id) === set) waiters.delete(id)
      done()
    }
    const timer = setTimeout(finish, Math.max(0, Math.min(ms, MAX_DELAY_MS)))
    set.add(finish)
    signal.addEventListener('abort', finish)
  })
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---- the bridge to the window ---------------------------------------------------

let bridgeWin: BrowserWindow | null = null
let rendererReady = false
const readyWaiters = new Set<() => void>()
let nextReq = 1
const inflight = new Map<number, (r: BridgeReply) => void>()

/** The window whose renderer carries out `new`. Its reloads and crashes drop what it was doing. */
export function setScriptingWindow(win: BrowserWindow): void {
  bridgeWin = win
  rendererReady = false
  const drop = (why: string): void => {
    rendererReady = false
    for (const [reqId, done] of [...inflight]) done({ reqId, ok: false, error: `${why} before the session was set up` })
    inflight.clear()
  }
  win.webContents.on('did-start-loading', () => drop('the window reloaded'))
  win.webContents.on('render-process-gone', () => drop('the window crashed'))
  win.on('closed', () => {
    drop('the window closed')
    if (bridgeWin === win) bridgeWin = null
  })
}

/** The renderer has its sessions loaded and is listening (Channels.controlReady). */
export function rendererIsReady(): void {
  rendererReady = true
  for (const f of [...readyWaiters]) f()
}

/** The renderer's answer to a request (Channels.controlReply). */
export function bridgeReply(r: BridgeReply): void {
  const done = inflight.get(r?.reqId)
  if (!done) return
  inflight.delete(r.reqId)
  done(r)
}

async function askRenderer(args: BridgeNewArgs): Promise<BridgeReply> {
  const deadline = Date.now() + BRIDGE_TIMEOUT_MS
  while (!rendererReady || !bridgeWin || bridgeWin.isDestroyed()) {
    if (Date.now() >= deadline) return { reqId: 0, ok: false, error: "the window isn't up — is Terminator still starting?" }
    await new Promise<void>((r) => {
      const t = setTimeout(go, 1000)
      function go(): void {
        clearTimeout(t)
        readyWaiters.delete(go)
        r()
      }
      readyWaiters.add(go)
    })
  }
  const win = bridgeWin
  const reqId = nextReq++
  return new Promise((done) => {
    const timer = setTimeout(() => {
      inflight.delete(reqId)
      done({ reqId, ok: false, error: "the window didn't finish setting the session up within 2 minutes" })
    }, BRIDGE_TIMEOUT_MS)
    inflight.set(reqId, (r) => {
      clearTimeout(timer)
      done(r)
    })
    const req: BridgeRequest = { reqId, cmd: 'new', args }
    win.webContents.send(Channels.controlRequest, req)
  })
}

/**
 * Tell the window that whatever slides into a pane because `id` is going away
 * arrived on a script's account, not yours — so it doesn't take the keyboard.
 * Sent ahead of the removal; messages to the window arrive in order.
 */
function quietRenderer(id: string): void {
  if (bridgeWin && !bridgeWin.isDestroyed() && rendererReady) bridgeWin.webContents.send(Channels.controlQuiet, id)
}

// ---- the commands -------------------------------------------------------------

type Handler<C extends ControlCommand> = (a: ControlRequests[C], signal: AbortSignal) => Promise<ControlResponse<C>>

const list: Handler<'list'> = async () => ({ ok: true, sessions: sidebarOrder().map(listed) })

/**
 * A folder that isn't there, said plainly — checked before anything exists, since
 * the dialog's create would make the session anyway and leave it to fail at start.
 * A WSL folder is checked inside its distro on the way in (normalizeCreateInput);
 * so is a bare `/…` on Windows, which the dialog reads as the default distro's.
 */
async function missingFolder(project: string, wsl: boolean): Promise<string | null> {
  if (wsl || parseWslUnc(project)) return null
  if (process.platform === 'win32' && project.startsWith('/') && !project.startsWith('//')) return null
  const abs = resolve(ptyMgr.expandHome(project) || project)
  try {
    if ((await stat(abs)).isDirectory()) return null
  } catch {
    // reported below
  }
  return `there's no folder at ${abs}`
}

const create: Handler<'new'> = async (a) => {
  if (a.kind !== 'claude' && a.kind !== 'shell') return fail('new makes a claude or a shell session')
  const project = typeof a.project === 'string' ? a.project.trim() : ''
  if (!project) return fail('--project is required: the folder the session works in')
  const branch = typeof a.branch === 'string' ? a.branch.trim() : ''
  // The dialog's branch box only shows — and is only read — with the worktree on.
  if (branch && !a.worktree) return fail("--branch names the worktree's branch, so it needs --worktree")
  const model = typeof a.model === 'string' ? a.model.trim() : undefined
  const effort = typeof a.effort === 'string' ? a.effort.trim() : undefined
  if ((model !== undefined || effort !== undefined) && a.kind !== 'claude') {
    return fail('--model and --effort are for a claude session')
  }
  const refused =
    (model !== undefined && launchRefusal('model', model)) || (effort !== undefined && launchRefusal('effort', effort))
  if (refused) return fail(refused)
  const runtime = validRuntime(a.runtime)
  const missing = await missingFolder(project, !!runtime)
  if (missing) return fail(missing)

  const r = await askRenderer({
    kind: a.kind,
    name: typeof a.name === 'string' ? a.name : '',
    folder: project,
    worktree: !!a.worktree,
    branch,
    runtime,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  })
  if (!r.ok) return fail(r.error)
  const s = state.getSession(r.id)
  if (!s) return fail('the session was removed while it was being set up')
  // The window opens and starts a session whose worktree failed — in the project
  // itself. A script asked for the worktree, so it hears that it didn't get one.
  if (r.createError) return fail(`${r.createError} — it started in ${s.projectPath} instead`, { id: s.id })
  return { ok: true, id: s.id, session: listed(s) }
}

/**
 * What a script types into one session goes in one thing at a time — a prompt, a
 * `/model` — each holding its place until its Enter is in.
 */
const sendChains = new Map<string, Promise<unknown>>()

async function inTurn<T>(id: string, typeIt: () => Promise<T>): Promise<T> {
  const prev = sendChains.get(id) ?? Promise.resolve()
  const run = prev.then(typeIt)
  const tail = run.catch(() => {})
  sendChains.set(id, tail)
  try {
    return await run
  } finally {
    if (sendChains.get(id) === tail) sendChains.delete(id)
  }
}

const send: Handler<'send'> = async (a, signal) => {
  const s = findSession(a.session)
  if (isFail(s)) return s
  const text = typeof a.text === 'string' ? a.text : ''
  return inTurn(s.id, () => sendWhenReady(s.id, text, signal))
}

/**
 * Send in the conversation view, plus the one thing a person does without
 * thinking: wait until Claude has its input box up. A refusal is the composer's
 * own (`sendRefusal`), and so is a dialog in the terminal — whether it was there
 * when the send came in or turned up while Claude was starting.
 */
async function sendWhenReady(id: string, text: string, signal: AbortSignal): Promise<ControlResponse<'send'>> {
  const notReady = await whenReady(id, signal)
  if (notReady) return notReady

  const s = state.getSession(id)
  if (!s) return fail('that session is gone')
  const offset = await transcriptSize(await conversationFile(s))
  const res = sendPrompt(id, text)
  if (!res.ok) return fail(res.reason)
  addScriptedPrompt(id, res.text, offset)
  // The Enter goes in SUBMIT_DELAY_MS after the paste; the next send waits it out.
  await delay(SUBMIT_DELAY_MS + 50)
  return { ok: true }
}

/** Until Claude has its input box up — or why it won't, as a failure. */
async function whenReady(id: string, signal: AbortSignal): Promise<ControlFailure | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    if (signal.aborted) return fail('cancelled')
    const s = state.getSession(id)
    // A WSL Claude still asking its distro isn't running yet, but it's on its way —
    // and so is one asking whether to trust its folder, which reads waiting.
    const onItsWay =
      !!s && s.kind === 'claude' && ((!s.alive && isStarting(id) && s.status !== 'waiting') || askingTrust(id))
    const refused = onItsWay ? null : sendRefusal(s)
    if (refused || !s) return fail(refused ?? 'that session is gone')
    if (!reportsStatus(id)) {
      return fail(`${s.name} can't report back to the app (WSL interop is off), so a script can't tell when it's ready`)
    }
    const since = readySince(id)
    if (since !== undefined) {
      const beat = since + READY_BEAT_MS - Date.now()
      if (beat <= 0) break
      await nextChange(id, beat, signal)
      continue
    }
    if (Date.now() >= deadline) {
      return fail(
        `${s.name} didn't finish starting within 2 minutes. If its terminal is asking something, answer it there, then send again.`,
      )
    }
    await nextChange(id, deadline - Date.now(), signal)
  }
  return null
}

/** How long a `/model` or `/effort` may take to answer in the transcript. */
const SWITCH_TIMEOUT_MS = 15_000

/**
 * The header's MODEL or EFFORT picker, from a script: `/model <m>` or `/effort <level>`
 * typed into Claude's input box, as the picker types it. Claude doesn't run its
 * statusLine again after either (see the picker), so the receipt is the transcript,
 * where Claude writes the command's own answer — "Set model to …" — as it runs it.
 */
async function switchTo(
  ref: string,
  what: 'model' | 'effort',
  raw: unknown,
  signal: AbortSignal,
): Promise<ControlResponse<'model'>> {
  const found = findSession(ref)
  if (isFail(found)) return found
  if (found.kind !== 'claude') return fail(`${found.name} is a ${found.kind} session — only a Claude session has a ${what}`)
  const value = typeof raw === 'string' ? raw.trim() : ''
  const refused = launchRefusal(what, value)
  if (refused) return fail(refused)
  const notReady = await whenReady(found.id, signal)
  if (notReady) return notReady
  const s = state.getSession(found.id)
  if (!s) return fail('that session is gone')
  // Typed into a turn, it would wait behind it as a queued message; a script asking
  // for the switch wants it before what it sends next, so it waits for idle first.
  if (s.status !== 'idle' || hasScriptedPrompt(s.id)) {
    return fail(`${s.name} is ${hasScriptedPrompt(s.id) ? 'about to work on a prompt' : word(s.status)} — wait for idle, then switch`)
  }
  const before = await conversationFile(s)
  const offset = await transcriptSize(before)
  const gen = ptyMgr.ptyGeneration(s.id)
  ptyMgr.writePty(s.id, `/${what} ${value}`)
  await delay(SUBMIT_DELAY_MS)
  if (ptyMgr.ptyGeneration(s.id) !== gen || !state.getSession(s.id)?.alive) return fail(`${s.name} stopped`)
  // Mid-conversation Claude asks before it changes model: "Switch model? … 1. Yes,
  // switch to …". The switch is what was asked for, so — as by hand — it's Yes,
  // the option the dialog has picked already. No hook says the dialog is up; its
  // words on the terminal do.
  let screen = ''
  const stopWatching =
    what === 'model'
      ? ptyMgr.onData((pid, data) => {
          if (pid === s.id) screen = (screen + ptyMgr.plainText(data)).slice(-4000)
        })
      : () => {}
  let confirmed = false
  ptyMgr.writePty(s.id, '\r')

  const deadline = Date.now() + SWITCH_TIMEOUT_MS
  let answer: string | null = null
  try {
    while (!signal.aborted && Date.now() < deadline) {
      await delay(250)
      const cur = state.getSession(s.id)
      if (!cur) return fail('that session is gone')
      if (!confirmed && /Switch\s*model\?/.test(screen) && /Yes,\s*switch/.test(screen)) {
        confirmed = true
        ptyMgr.writePty(s.id, '\r')
      }
      // A conversation's first record can be the command itself.
      const file = before ?? (await conversationFile(cur))
      answer = await commandAnswer(file, before ? offset : 0, what)
      if (answer !== null) break
    }
  } finally {
    stopWatching()
  }
  if (signal.aborted) return fail('cancelled')
  if (answer === null) return fail(`${s.name} didn't answer /${what} within 15 seconds — look at its terminal`)
  if (!/^set\b/i.test(answer)) return fail(answer || `${s.name} answered /${what} with nothing`)
  const cur = state.getSession(s.id)
  if (cur) {
    // Shown at once, as the picker shows its pick; the next statusLine report has the last word.
    const shown = what === 'model' ? (/`([^`]+)`/.exec(answer)?.[1] ?? value) : value
    state.updateSession(s.id, {
      metrics: { ...(cur.metrics ?? {}), [what]: shown },
      ...(what === 'model' ? { launchModel: value } : { launchEffort: value }),
    })
  }
  return { ok: true, message: answer }
}

/**
 * What Claude printed for the last `/<what>` in a transcript past `from`, or null
 * while it hasn't. The command and its output are records of their own, one after
 * the other: `<command-name>/model</command-name>`, then `<local-command-stdout>`.
 * A command that worked is written as the user's; one that didn't — an unknown
 * model — as a `system` record with the same words in its `content`.
 */
async function commandAnswer(file: string | null, from: number, what: string): Promise<string | null> {
  if (!file) return null
  const size = await transcriptSize(file)
  if (size <= from) return null
  const text = (await readRange(file, from, size - from))?.toString('utf8') ?? ''
  let ours = false
  let answer: string | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('<command-name>') && !line.includes('<local-command-stdout>')) continue
    let content = ''
    try {
      const rec = JSON.parse(line) as { message?: { content?: unknown }; content?: unknown }
      const c = rec.message?.content ?? rec.content
      content = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? '').join('') : ''
    } catch {
      continue // the last line, still being written
    }
    const name = /<command-name>\/?([^<]*)<\/command-name>/.exec(content)
    if (name) {
      ours = name[1].trim() === what
      continue
    }
    const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(content)
    if (out && ours) answer = out[1].replace(/\x1b\[[0-9;]*m/g, '').trim()
  }
  return answer
}

const wait: Handler<'wait'> = async (a, signal) => {
  const first = findSession(a.session)
  if (isFail(first)) return first
  const words = Array.isArray(a.statuses) ? a.statuses : []
  if (!words.length) return fail('name the statuses to wait for: idle, working, waiting, error or closed')
  const bad = words.find((w) => !Object.hasOwn(STATUS_OF, w))
  if (bad !== undefined) return fail(`${String(bad)} isn't a status — use idle, working, waiting, error or closed`)
  const want = new Set(words.map((w) => STATUS_OF[w]))
  const timeoutMs = typeof a.timeoutMs === 'number' && a.timeoutMs >= 0 ? a.timeoutMs : Infinity
  const deadline = Date.now() + timeoutMs
  const id = first.id

  for (;;) {
    const s = state.getSession(id)
    if (!s) return fail(`${first.name} was removed`)
    // A prompt a script sent that Claude hasn't taken yet: idle and error still
    // describe the turn before it. Waiting and closed are news either way.
    const stale = hasScriptedPrompt(id) && (s.status === 'idle' || s.status === 'error')
    if (want.has(s.status) && !stale) {
      return lastPromptGivenUp(id)
        ? {
            ok: true,
            status: word(s.status),
            warning:
              "the last prompt sent never showed up as a turn of its own (a slash command, or folded into the turn before it), so this is the session's status, not that prompt's",
          }
        : { ok: true, status: word(s.status) }
    }
    if (signal.aborted) return fail('cancelled')
    if (Date.now() >= deadline) {
      return fail(`timed out: ${s.name} is ${word(s.status)}`, { timedOut: true, status: word(s.status) })
    }
    await nextChange(id, deadline - Date.now(), signal)
  }
}

/** Copy reply, for the newest turn that's over. */
const reply: Handler<'reply'> = async (a) => {
  const s = findSession(a.session)
  if (isFail(s)) return s
  if (s.kind !== 'claude') return fail(`${s.name} is a ${s.kind} session — only a Claude session has replies`)
  const file = await conversationFile(s)
  const turns = file ? toTurns((await readConversation(file, 0)).items) : []
  // While Claude is working, or blocked on you mid-turn, its last turn isn't over.
  const over = s.alive && (s.status === 'busy' || s.status === 'waiting') ? turns.slice(0, -1) : turns
  const last = over[over.length - 1]
  if (!last) return fail(`${s.name} has no finished reply yet`)
  const markdown = replyText(last)
  // Said rather than skipped: falling back to an older turn would hand a script
  // the answer to a different question.
  if (!markdown) return fail(`${s.name}'s latest finished turn has no reply text, only tool calls`)
  return { ok: true, markdown }
}

/** Stop in the session menu — offered only for a session that's running. */
const stop: Handler<'stop'> = async (a, signal) => {
  const s = findSession(a.session)
  if (isFail(s)) return s
  if (isProcessless(s.kind)) return fail(`${s.name} has no process to stop`)
  if (!s.alive && !isStarting(s.id)) return fail(`${s.name} isn't running`)
  stopSession(s.id)
  const deadline = Date.now() + STOP_TIMEOUT_MS
  for (;;) {
    const cur = state.getSession(s.id)
    if (!cur || (!cur.alive && !isStarting(s.id))) return { ok: true }
    if (Date.now() >= deadline) return fail(`${s.name} hasn't stopped after 10 seconds`)
    await nextChange(s.id, deadline - Date.now(), signal)
  }
}

/**
 * Remove, with its worktree question already answered. The order is the dialog's
 * (ConfirmDialog.tsx): the worktree first, because main finds its path through the
 * session — and, like the dialog, a worktree git won't delete leaves everything
 * where it was.
 */
const remove: Handler<'remove'> = async (a) => {
  const s = findSession(a.session)
  if (isFail(s)) return s
  if (a.removeWorktree && s.worktreePath) {
    try {
      await removeWorktree(s.id)
    } catch (e) {
      return fail(`couldn't remove the worktree at ${s.worktreePath} (${errorText(e)}), so nothing was removed`)
    }
  }
  quietRenderer(s.id)
  state.removeSession(s.id)
  return { ok: true }
}

const model: Handler<'model'> = async (a, signal) => {
  const s = findSession(a.session)
  return isFail(s) ? s : inTurn(s.id, () => switchTo(s.id, 'model', a.model, signal))
}
const effort: Handler<'effort'> = async (a, signal) => {
  const s = findSession(a.session)
  return isFail(s) ? s : inTurn(s.id, () => switchTo(s.id, 'effort', a.effort, signal))
}

const commands: { [C in ControlCommand]: Handler<C> } = {
  list,
  new: create,
  send,
  wait,
  reply,
  model,
  effort,
  stop,
  remove,
}

export function isCommand(name: string): name is ControlCommand {
  return Object.hasOwn(commands, name)
}

/** Carry out one request. `signal` aborts when the caller goes away or scripting is turned off. */
export async function runCommand<C extends ControlCommand>(
  name: C,
  body: ControlRequests[C],
  signal: AbortSignal,
): Promise<ControlResponse<C>> {
  try {
    return await (commands[name] as Handler<C>)(body, signal)
  } catch (e) {
    return fail(errorText(e))
  }
}

/** Wake waiters on every change to a session or its turn. */
export function wireScripting(): void {
  state.onSessionChange((id) => wake(id))
  onTurnChange((id) => wake(id))
}
