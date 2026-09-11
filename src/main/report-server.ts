import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { REPORTER_SOURCE } from './reporter-source'
import { getSession, notify, setStatus, updateSession } from './state'
import { flushPendingPrompt } from './prefill'
import { recordUsage } from './usage-store'
import type { SessionMetrics, SessionStatus, UsageWindow } from '../shared/types'

let server: Server | null = null
let port = 0
let token = ''
let reporterFile = ''

export function reportPort(): number {
  return port
}
export function reportToken(): string {
  return token
}
export function reporterPath(): string {
  return reporterFile
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function startReportServer(): Promise<void> {
  token = randomBytes(24).toString('hex')

  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  reporterFile = join(dir, 'reporter.cjs')
  writeFileSync(reporterFile, REPORTER_SOURCE, 'utf8')

  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const auth = (req.headers['authorization'] as string) || ''
      if (!safeEqual(auth, 'Bearer ' + token)) {
        res.statusCode = 401
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end()
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.statusCode = 204
        res.end()
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(body || '{}')
        } catch {
          return
        }
        // The reporter stamps each report when Claude spawned it; without that, all
        // we would know is delivery order, which is not emission order (see handleHook).
        const at = Number(req.headers['x-terminator-ts']) || Date.now()
        if (req.url === '/hook') handleHook(payload, at)
        else if (req.url === '/status') handleStatus(payload)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      resolve()
    })
  })
}

export function stopReportServer(): void {
  server?.close()
  server = null
}

// ---- event handling --------------------------------------------------------

/**
 * The `notification_type` values that mean Claude has stopped and is blocked on you.
 * Claude fires the Notification hook for a dozen other reasons — a background agent
 * that finished, a successful login, an idle timeout, a quota that resumed — and each
 * of those announces something that already happened. This is an allowlist rather
 * than a denylist on purpose: a type we have never heard of must not be able to claim
 * a session needs you.
 */
const BLOCKING_NOTIFICATIONS = new Set([
  'permission_prompt', // "Claude needs your permission to use X" (raised ~6s into the dialog)
  'elicitation_dialog', // "Claude Code needs your input"
  'elicitation_url_dialog', // "An MCP server needs your input"
  'agent_needs_input', // a tracked agent is blocked on an answer
  'worker_permission_prompt', // "<worker> needs permission for X"
  'quota_auto_resume_stale', // "Usage limit reset — press enter to continue"
])

/**
 * What we know about the turn a hook belongs to.
 *
 * Every hook is its own process posting its own request, so the order they land in is
 * not the order Claude emitted them: a permission prompt raised mid-turn can arrive
 * after the Stop that ended that turn. Nothing in the payload orders them — there is
 * no timestamp and no sequence number — so the ordering is imposed here, from the
 * capture time the reporter stamps on and from `prompt_id`, which Claude holds
 * constant across every event belonging to one user prompt.
 */
interface Turn {
  /** `prompt_id` of the turn these events belong to. Absent before the first prompt. */
  promptId?: string
  /** Capture time of the newest event that was allowed to move the status. */
  lastAt: number
  /** Set once Stop/StopFailure landed for `promptId`; only a new prompt reopens it. */
  ended: boolean
  /** Live subagents: `agent_id` -> `agent_type`. */
  agents: Map<string, string>
}
const turns = new Map<string, Turn>()

/**
 * Events that define a turn boundary rather than happen inside one. They are never
 * suppressed as "that turn already ended" — they are what ends or reopens a turn.
 */
const TURN_BOUNDARY = new Set(['UserPromptSubmit', 'SessionStart', 'Stop', 'StopFailure'])

/**
 * How far behind the newest event a report may be and still count as out of order.
 * The reporter hard-exits 2.5s after it stamps itself, so nothing legitimate lands
 * later than that; a bigger gap means the machine's clock stepped (NTP, waking from
 * sleep) rather than that this event is old — and treating a stepped clock as "stale"
 * would freeze the session's status for good, since the newest stamp never advances.
 */
const ORDER_WINDOW_MS = 5000

function turnOf(id: string): Turn {
  let t = turns.get(id)
  if (!t) {
    t = { lastAt: 0, ended: false, agents: new Map() }
    turns.set(id, t)
  }
  return t
}

/** A non-empty string field, or undefined — hook payloads are only best-effort typed. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** Activity label while subagents are running, or undefined when none are. */
function subagentActivity(t: Turn): string | undefined {
  const n = t.agents.size
  if (n === 0) return undefined
  if (n > 1) return `running ${n} subagents`
  return `running ${[...t.agents.values()][0] || 'subagent'}`
}

function handleHook(p: Record<string, unknown>, at: number): void {
  const id = str(p.session_id)
  if (!id) return
  const s = getSession(id)
  // A hook from a process the app has already buried is stale by definition, and a
  // straggling Stop would otherwise pull a stopped session back out of 'closed'.
  if (!s || !s.alive) {
    turns.delete(id)
    return
  }
  const event = String(p.hook_event_name ?? '')
  // SessionEnd is handled by the PTY exit path.
  if (event === 'SessionEnd') {
    turns.delete(id)
    return
  }

  const promptId = str(p.prompt_id)
  const t = turnOf(id)
  // A new prompt_id is a new turn: what we knew about the last one is history.
  if (promptId && promptId !== t.promptId) {
    t.promptId = promptId
    t.ended = false
    t.agents.clear()
  }
  // Anything Claude emitted before the newest event we already acted on is stale by
  // the time it reaches us, whatever order it arrived in.
  const behind = t.lastAt - at
  if (behind > 0 && behind <= ORDER_WINDOW_MS) return

  // The idle nudge is judged before the turn-ended guard below, because being raised
  // after a turn ended is the whole point of it. "Claude is waiting for your input" is
  // an idle *timeout*, roughly a minute after the turn was already over: nothing is
  // blocked, so the status stands and the "needs me" dot stays off. It is a nudge
  // about a session you may have walked away from, and only means anything if the
  // session really is sitting idle.
  if (event === 'Notification' && str(p.notification_type) === 'idle_prompt') {
    if (s.status === 'idle') notify(id, 'idle', str(p.message) ?? `${s.name} is waiting for you`)
    return
  }

  // A turn that has already ended can only be reopened by the next prompt — the
  // clock-free backstop, for when two hooks share a millisecond.
  if (t.ended && promptId && promptId === t.promptId && !TURN_BOUNDARY.has(event)) return

  /** Move the status, and record this event as the newest one acted on. */
  const apply = (status: SessionStatus, activity: string): void => {
    t.lastAt = at
    setStatus(id, status, activity)
  }

  /**
   * Enter the waiting state. The notification fires only on the way in: Claude
   * re-raises its permission notification while a dialog sits unanswered, and
   * repeating the alarm about a prompt you have already been told about is noise.
   */
  const enterWaiting = (activity: string, message: string): void => {
    const already = s.status === 'waiting'
    apply('waiting', activity)
    if (!already) notify(id, 'waiting', message)
  }

  switch (event) {
    // ---- Claude is working -------------------------------------------------
    case 'UserPromptSubmit':
      t.ended = false
      t.agents.clear()
      apply('busy', 'working')
      return
    case 'PreToolUse': {
      const tool = str(p.tool_name)
      apply('busy', tool ? `using ${tool}` : 'working')
      return
    }
    case 'PostToolUse':
      apply('busy', subagentActivity(t) ?? 'working')
      return
    case 'PreCompact':
      apply('busy', 'compacting')
      return
    case 'SubagentStart': {
      const agentId = str(p.agent_id)
      if (agentId) t.agents.set(agentId, str(p.agent_type) ?? 'subagent')
      apply('busy', subagentActivity(t) ?? 'working')
      return
    }
    case 'SubagentStop': {
      // Deliberately not the Stop branch below: a subagent finishing leaves the
      // parent turn running, and reporting it as finished is how a session gets
      // stuck looking done while Claude is still working.
      const agentId = str(p.agent_id)
      if (agentId) t.agents.delete(agentId)
      apply('busy', subagentActivity(t) ?? 'working')
      return
    }

    // ---- Claude is blocked on you ------------------------------------------
    case 'PermissionRequest': {
      const tool = str(p.tool_name)
      enterWaiting(
        tool ? `permission: ${tool}` : 'waiting for permission',
        tool ? `${s.name} needs permission for ${tool}` : `${s.name} needs your input`,
      )
      return
    }
    case 'Elicitation': {
      const server = str(p.mcp_server_name)
      enterWaiting(
        server ? `${server} needs input` : 'waiting for input',
        str(p.message) ?? `${s.name} needs your input`,
      )
      return
    }
    case 'Notification': {
      // idle_prompt is already handled above; everything that is left either means
      // Claude has stopped for you, or announces something that completed, resolved
      // or timed out — and those must not touch the status.
      const type = str(p.notification_type)
      if (type && BLOCKING_NOTIFICATIONS.has(type)) {
        enterWaiting('waiting for input', str(p.message) ?? `${s.name} needs your input`)
      }
      return
    }

    // ---- The turn is over --------------------------------------------------
    case 'Stop': {
      const wasActive = s.status === 'busy' || s.status === 'waiting'
      t.ended = true
      t.agents.clear()
      apply('idle', 'finished')
      if (wasActive) notify(id, 'finished', `${s.name} finished`)
      return
    }
    case 'StopFailure': {
      // The turn itself failed — an API error, a rate limit, an exhausted retry. Its
      // own hook, separate from Stop, which only ever fires on the success path.
      const reason = str(p.error) ?? 'unknown'
      t.ended = true
      t.agents.clear()
      apply('error', `error: ${reason}`)
      notify(id, 'error', `${s.name} hit an error: ${str(p.error_details) ?? reason}`)
      return
    }

    case 'SessionStart':
      // 'compact' fires mid-turn, when Claude compacts the conversation and carries on.
      // Treating that as a fresh session would reset a live turn to "ready" and type a
      // branch's queued prompt into the middle of Claude's own work.
      if (str(p.source) === 'compact') return
      t.ended = false
      t.agents.clear()
      apply('idle', 'ready')
      // A branch can carry the prompt it was cut before, as an editable draft.
      flushPendingPrompt(id)
      return
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * `resets_at` arrives as a unix epoch *number* — seconds, despite how it reads. A
 * value already in milliseconds is passed through, so this stays right either way
 * rather than turning the countdown into a fifty-thousand-year wait: 1e11 is four
 * orders of magnitude clear of "now" in both units.
 */
function epochMs(v: unknown): number | undefined {
  const n = num(v)
  if (n === undefined || n <= 0) return undefined
  const ms = n < 1e11 ? n * 1000 : n
  // Anything outside 2000..2100 is not a reset time, it's noise — better no
  // countdown at all than one measured in centuries.
  return ms >= 946_684_800_000 && ms <= 4_102_444_800_000 ? Math.round(ms) : undefined
}

/** One window of `rate_limits`, or undefined when it's absent or unusable. */
function usageWindow(v: unknown): UsageWindow | undefined {
  const w = v as { used_percentage?: unknown; resets_at?: unknown } | undefined
  const usedPct = num(w?.used_percentage)
  if (usedPct === undefined) return undefined
  const resetsAt = epochMs(w?.resets_at)
  return resetsAt === undefined ? { usedPct } : { usedPct, resetsAt }
}

function handleStatus(p: Record<string, unknown>): void {
  const id = typeof p.session_id === 'string' ? p.session_id : ''
  if (!id) return
  const s = getSession(id)
  if (!s) return

  const model = p.model as { display_name?: string; id?: string } | undefined
  const effort = p.effort as { level?: string } | undefined
  const cw = (p.context_window as Record<string, unknown>) || {}
  const cost = p.cost as { total_cost_usd?: number } | undefined

  const next: SessionMetrics = { ...(s.metrics ?? {}) }
  if (model?.display_name || model?.id) next.model = model.display_name ?? model.id
  if (effort?.level) next.effort = effort.level
  const pct = num(cw.used_percentage)
  if (pct !== undefined) next.contextPct = pct
  const ctxTokens = num(cw.total_input_tokens) ?? num(cw.current_usage) ?? num(cw.used_tokens)
  if (ctxTokens !== undefined) next.contextTokens = ctxTokens
  const c = num(cost?.total_cost_usd)
  if (c !== undefined) next.costUsd = c

  updateSession(id, { metrics: next })

  // The rate limits are the account's, not this session's, so they go to the global
  // store — which is what lets an idle or unfocused pane still show the real number.
  const limits = p.rate_limits as { five_hour?: unknown; seven_day?: unknown } | undefined
  recordUsage({ fiveHour: usageWindow(limits?.five_hour), weekly: usageWindow(limits?.seven_day) })
}
