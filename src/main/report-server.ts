import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { REPORTER_SOURCE } from './reporter-source'
import { getSession, notify, setStatus, updateSession } from './state'
import { flushPendingPrompt } from './prefill'
import { recordUsage } from './usage-store'
import type { SessionMetrics, UsageWindow } from '../shared/types'

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
        if (req.url === '/hook') handleHook(payload)
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

const BUSY = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact'])
const WAIT = new Set(['Notification', 'PermissionRequest', 'Elicitation'])

function activityFor(event: string, p: Record<string, unknown>): string {
  if (event === 'PreToolUse' && typeof p.tool_name === 'string') return `using ${p.tool_name}`
  if (event === 'PostToolUse') return 'working'
  if (event === 'UserPromptSubmit') return 'working'
  return 'working'
}

function handleHook(p: Record<string, unknown>): void {
  const id = typeof p.session_id === 'string' ? p.session_id : ''
  if (!id) return
  const s = getSession(id)
  if (!s) return
  const event = String(p.hook_event_name ?? '')

  if (BUSY.has(event)) {
    setStatus(id, 'busy', activityFor(event, p))
  } else if (WAIT.has(event)) {
    setStatus(id, 'waiting', 'waiting for input')
    notify(id, 'waiting', typeof p.message === 'string' && p.message ? p.message : `${s.name} needs your input`)
  } else if (event === 'Stop') {
    const wasBusy = s.status === 'busy'
    setStatus(id, 'idle', 'finished')
    if (wasBusy) notify(id, 'finished', `${s.name} finished`)
  } else if (event === 'StopFailure') {
    setStatus(id, 'error', 'error')
    notify(id, 'error', `${s.name} hit an error`)
  } else if (event === 'SessionStart') {
    setStatus(id, 'idle', 'ready')
    // A branch can carry the prompt it was cut before, as an editable draft.
    flushPendingPrompt(id)
  }
  // SessionEnd is handled by the PTY exit path.
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
