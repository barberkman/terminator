import { app, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Channels } from '../shared/channels'
import type { UsageSnapshot, UsageWindow } from '../shared/types'

/**
 * Claude's 5-hour and weekly rate-limit windows, which are facts about the account
 * rather than about a session. Every running session's statusLine reports the same
 * two numbers, so they are held once, here, and the footer shows this no matter which
 * pane has focus.
 *
 * Kept out of sessions.json deliberately: that file is per-session durable metadata
 * and drops runtime fields on restore, whereas the whole point of this one is to be
 * there on the next launch. Storage is theme-store.ts's shape — one cached copy, a
 * tolerant read, an atomic write — and the broadcast is state.ts's: a window ref, a
 * private emit, a debounced persist.
 *
 * Nothing in here polls. The only inbound signal is the statusLine report Claude
 * already makes after a turn; the countdown and the staleness hint are the renderer
 * reading its own clock against `resetsAt` and `updatedAt`.
 */

const EMPTY: UsageSnapshot = { updatedAt: 0 }

function file(): string {
  return join(app.getPath('userData'), 'usage.json')
}

let cached: UsageSnapshot | null = null
let mainWindow: BrowserWindow | null = null

export function setWindow(w: BrowserWindow): void {
  mainWindow = w
}

function emit(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * The one validator, run on both routes in — a report from Claude and a file someone
 * hand-edited — so what is cached, persisted and broadcast is always a shape the
 * footer can render.
 */
function cleanWindow(v: unknown): UsageWindow | undefined {
  if (!v || typeof v !== 'object') return undefined
  const w = v as { usedPct?: unknown; resetsAt?: unknown }
  const pct = num(w.usedPct)
  if (pct === undefined) return undefined
  const usedPct = Math.max(0, Math.min(100, pct))
  const resetsAt = num(w.resetsAt)
  return resetsAt !== undefined && resetsAt > 0 ? { usedPct, resetsAt } : { usedPct }
}

function clean(v: unknown): UsageSnapshot {
  if (!v || typeof v !== 'object') return EMPTY
  const s = v as { fiveHour?: unknown; weekly?: unknown; updatedAt?: unknown }
  const next: UsageSnapshot = { updatedAt: num(s.updatedAt) ?? 0 }
  const fiveHour = cleanWindow(s.fiveHour)
  if (fiveHour) next.fiveHour = fiveHour
  const weekly = cleanWindow(s.weekly)
  if (weekly) next.weekly = weekly
  return next
}

export function loadUsage(): UsageSnapshot {
  if (cached) return cached
  cached = EMPTY
  const f = file()
  if (existsSync(f)) {
    try {
      cached = clean(JSON.parse(readFileSync(f, 'utf8')) as unknown)
    } catch {
      // A corrupt file costs the last-known numbers, never the app.
    }
  }
  return cached
}

let saveTimer: NodeJS.Timeout | null = null

function write(): void {
  if (!cached) return
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    const f = file()
    const tmp = `${f}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(cached, null, 2), 'utf8')
    renameSync(tmp, f)
  } catch {
    // Best effort, same as the session list.
  }
}

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(write, 400)
}

/**
 * Write any pending save now. Called on quit: surviving a restart is what this store
 * is *for*, so unlike the session list it can't afford to lose the last debounce.
 */
export function flushUsage(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  write()
}

/**
 * Fold a statusLine report's rate limits in. Merged per window, and a report carrying
 * neither is ignored outright — `rate_limits` goes missing intermittently, and the
 * last-known numbers are better than a blank meter. Ignoring it also keeps `updatedAt`
 * honest: it means "when these numbers arrived", not "when a report last arrived".
 */
export function recordUsage(next: { fiveHour?: UsageWindow; weekly?: UsageWindow }): void {
  const fiveHour = cleanWindow(next.fiveHour)
  const weekly = cleanWindow(next.weekly)
  if (!fiveHour && !weekly) return
  const cur = loadUsage()
  cached = {
    fiveHour: fiveHour ?? cur.fiveHour,
    weekly: weekly ?? cur.weekly,
    updatedAt: Date.now(),
  }
  emit(Channels.usageUpdated, cached)
  persist()
}
