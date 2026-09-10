import { useEffect, useState } from 'react'
import { USAGE_REFRESH_DEFAULT, type UsageSnapshot, type UsageWindow } from '../../shared/types'
import { C, STATUS_COLORS, STATUS_LABELS, ink, dotStyle } from '../theme'
import { Icon } from '../icons'
import { useStore } from '../state/store'

/** Past this, a reported percentage is old enough that the footer should say so. */
const STALE_AFTER_MS = 2 * 60_000

/**
 * One window. At most one of `reset` and `note` is ever set: `reset` is a time the
 * window rolls over at, marked with the app's own restart glyph so the row doesn't
 * have to spend a phrase saying "resets in"; `note` is anything else, plain.
 */
function Meter({
  label,
  pct,
  reset,
  note,
}: {
  label: string
  pct: number
  reset?: string
  note?: string
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
      <span style={{ color: C.muted, whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ width: 54, height: 4, borderRadius: 2, background: ink(0.1), overflow: 'hidden', flex: 'none' }}>
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, pct)}%`,
            background: pct > 85 ? STATUS_COLORS.error : C.accent,
          }}
        />
      </div>
      <span style={{ color: C.textHi, fontWeight: 600, whiteSpace: 'nowrap' }}>{Math.round(pct)}%</span>
      {reset ? (
        // The icon takes its colour from this span (it strokes with currentColor).
        <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: C.dim, whiteSpace: 'nowrap' }}>
          <Icon name="restart" size={10} />
          {reset}
        </span>
      ) : null}
      {note ? <span style={{ color: C.faint, whiteSpace: 'nowrap' }}>{note}</span> : null}
    </div>
  )
}

/**
 * "3d2h", "4h58m", "12m", "<1m" — minute granularity, which is all the tick can
 * honour, and no inner space, because this sits in a footer row that is short on
 * width. Past two days it switches to days, so the weekly window reads as a span
 * rather than as "72h0m".
 */
function until(ms: number): string {
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return '<1m'
  const hours = Math.floor(mins / 60)
  if (hours >= 48) return `${Math.floor(hours / 24)}d${hours % 24}h`
  return hours ? `${hours}h${mins % 60}m` : `${mins}m`
}

/**
 * "Thu 17:00" — a countdown spanning days is unreadable, so the week gets a date.
 * The clock is pinned to 24-hour rather than following the locale the way the app's
 * other two time formatters do: " PM" is three characters of nothing in a row this
 * tight. `hourCycle` rather than `hour12: false`, which would conflict with it and
 * can render midnight as "24:00".
 */
function dayTime(at: number): string {
  const d = new Date(at)
  const day = d.toLocaleDateString([], { weekday: 'short' })
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `${day} ${time}`
}

/** How long ago the numbers arrived: "12m", "3h", "2d". */
function agoText(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 90) return `${mins}m`
  const hours = Math.round(ms / 3_600_000)
  return hours < 48 ? `${hours}h` : `${Math.round(ms / 86_400_000)}d`
}

interface MeterView {
  pct: number
  /** A time this window rolls over at — the row marks it with the restart glyph. */
  reset?: string
  /** Anything that isn't a reset time. Never set at the same time as `reset`. */
  note?: string
  expired: boolean
}

/**
 * What one window shows right now — pure in `(window, now)`, which is what lets the
 * bar zero itself the moment a reset passes with nothing arriving from Claude. Each
 * window shows the form that reads best and carries the other one on hover.
 */
function meterView(w: UsageWindow | undefined, now: number, weekly: boolean): MeterView | null {
  if (!w) return null
  const at = w.resetsAt
  if (at === undefined) return { pct: w.usedPct, expired: false }
  // Rolled over: no glyph, because there is no future reset time to point at and
  // the hover already says when it happened.
  if (now >= at) return { pct: 0, note: 'reset', expired: true }
  return weekly
    ? { pct: w.usedPct, reset: dayTime(at), expired: false }
    : { pct: w.usedPct, reset: until(at - now), expired: false }
}

/**
 * The whole picture on hover, including the bit the row has no room for: each window
 * in both forms, and when these numbers last arrived. On an idle app that last line
 * is the answer to "is this thing live or stuck?", which a slow-moving percentage and
 * a minute-granularity countdown can't give on their own.
 */
function summaryText(usage: UsageSnapshot | null, now: number): string {
  if (!usage || (!usage.fiveHour && !usage.weekly)) {
    return [
      'No usage reported yet.',
      'Claude sends these figures when a session finishes a turn; from then on they',
      'are shared by every session and kept across restarts.',
    ].join('\n')
  }
  const lines: string[] = []
  const add = (label: string, w: UsageWindow | undefined): void => {
    if (!w) return
    const pct = `${Math.round(w.usedPct)}% used`
    if (w.resetsAt === undefined) lines.push(`${label}: ${pct} (no reset time reported)`)
    else if (now >= w.resetsAt) lines.push(`${label}: 0% used — the window reset ${dayTime(w.resetsAt)}`)
    else lines.push(`${label}: ${pct}, resets ${dayTime(w.resetsAt)} — ${until(w.resetsAt - now)} left`)
  }
  add('5-hour', usage.fiveHour)
  add('Weekly', usage.weekly)
  // Spelled out both ways: the elapsed time is what says whether this is live, and
  // the clock time disambiguates it once "2d ago" stops being precise enough.
  lines.push(
    usage.updatedAt
      ? `Last reported by a session ${agoText(now - usage.updatedAt)} ago, at ${dayTime(usage.updatedAt)}`
      : 'Never reported by a session',
  )
  return lines.join('\n')
}

/**
 * A clock that advances on its own, so the countdown moves between reports. The
 * period comes from settings and is in the dep array, so changing it re-arms the
 * timer rather than waiting for a restart.
 */
function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), periodMs)
    return () => clearInterval(t)
  }, [periodMs])
  return now
}

/**
 * The account's rate limits — global, not the focused session's. Split out from the
 * footer so a tick repaints this cluster and leaves the session name and path alone.
 */
function UsageCluster(): React.JSX.Element {
  const usage = useStore((s) => s.usage)
  const refreshSeconds = useStore((s) => s.settings?.usageRefreshSeconds)
  const now = useNow((refreshSeconds ?? USAGE_REFRESH_DEFAULT) * 1000)

  const five = meterView(usage?.fiveHour, now, false)
  const week = meterView(usage?.weekly, now, true)
  // A rolled-over window reads 0% because it *is* 0%, so it needs no caveat. The
  // hint is for a number Claude reported that nothing has confirmed since.
  const anyLive = [five, week].some((v) => v !== null && !v.expired)
  const age = usage && usage.updatedAt ? now - usage.updatedAt : 0
  const stale = anyLive && age >= STALE_AFTER_MS

  // The same dot the session cluster uses, so the compact tokens don't run together.
  const dot = <span style={{ color: C.faint2 }}>·</span>

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}
      title={summaryText(usage, now)}
    >
      <span style={{ fontSize: 9.5, letterSpacing: 0.6, color: C.dim, fontWeight: 700 }}>USAGE</span>
      {five || week ? (
        <>
          {five ? <Meter label="5h" pct={five.pct} reset={five.reset} note={five.note} /> : null}
          {five && week ? dot : null}
          {week ? <Meter label="7d" pct={week.pct} reset={week.reset} note={week.note} /> : null}
          {stale ? (
            <>
              {dot}
              <span style={{ color: C.faint, whiteSpace: 'nowrap' }}>{agoText(age)} ago</span>
            </>
          ) : null}
        </>
      ) : (
        <span style={{ color: C.faint }}>—</span>
      )}
    </div>
  )
}

export function Footer(): React.JSX.Element {
  const focusedId = useStore((s) => s.panes[s.focused])
  const session = useStore((s) => (focusedId ? s.sessions[focusedId] : undefined))
  const cwd = session ? session.worktreePath || session.projectPath : ''

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        height: 40,
        flex: 'none',
        padding: '0 16px',
        background: C.footer,
        borderTop: `1px solid ${C.border}`,
        fontSize: 11.5,
        color: C.muted,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none', minWidth: 0 }}>
        {session ? (
          <>
            <span style={dotStyle(session.status, 8)} />
            <span style={{ color: C.textHi, fontWeight: 600, whiteSpace: 'nowrap' }}>{session.name}</span>
            <span style={{ color: C.faint2 }}>·</span>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {STATUS_LABELS[session.status]} — {session.activity}
            </span>
          </>
        ) : (
          <span style={{ color: C.faint }}>No session open</span>
        )}
      </div>
      {/* Working directory — fills the middle, truncated from the start so the
          end (the relevant part) stays visible, adapting to window width. */}
      <div style={{ flex: 1, minWidth: 24, padding: '0 14px', overflow: 'hidden' }} title={cwd}>
        {session && (
          <div
            dir="rtl"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: C.dim,
              fontSize: 11,
            }}
          >
            <span dir="ltr">{cwd}</span>
          </div>
        )}
      </div>
      <UsageCluster />
    </div>
  )
}
