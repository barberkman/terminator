import { useEffect, useState } from 'react'
import { USAGE_REFRESH_DEFAULT, type UsageWindow } from '../../shared/types'
import { C, STATUS_COLORS, STATUS_LABELS, ink, dotStyle } from '../theme'
import { useStore } from '../state/store'

/** Past this, a reported percentage is old enough that the footer should say so. */
const STALE_AFTER_MS = 2 * 60_000

function Meter({
  label,
  pct,
  note,
  title,
}: {
  label: string
  pct: number
  note?: string
  title?: string
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 'none' }} title={title}>
      <span style={{ color: C.muted, whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ width: 70, height: 4, borderRadius: 2, background: ink(0.1), overflow: 'hidden', flex: 'none' }}>
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, pct)}%`,
            background: pct > 85 ? STATUS_COLORS.error : C.accent,
          }}
        />
      </div>
      <span style={{ color: C.textHi, fontWeight: 600, whiteSpace: 'nowrap' }}>{Math.round(pct)}%</span>
      {note ? <span style={{ color: C.dim, whiteSpace: 'nowrap' }}>{note}</span> : null}
    </div>
  )
}

/** "4h 58m", "12m", "<1m" — minute granularity, which is all the tick can honour. */
function until(ms: number): string {
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return '<1m'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

/** "Thu 09:00" — a countdown spanning days is unreadable, so the week gets a date. */
function dayTime(at: number): string {
  const d = new Date(at)
  const day = d.toLocaleDateString([], { weekday: 'short' })
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
  note: string
  title: string
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
  if (at === undefined) {
    return { pct: w.usedPct, note: '', title: 'No reset time reported', expired: false }
  }
  if (now >= at) {
    return { pct: 0, note: 'reset', title: `Window rolled over ${dayTime(at)}`, expired: true }
  }
  return weekly
    ? { pct: w.usedPct, note: `resets ${dayTime(at)}`, title: `${until(at - now)} left`, expired: false }
    : { pct: w.usedPct, note: `resets in ${until(at - now)}`, title: `Resets ${dayTime(at)}`, expired: false }
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

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>
      <span style={{ fontSize: 9.5, letterSpacing: 0.6, color: C.dim, fontWeight: 700 }}>USAGE</span>
      {five || week ? (
        <>
          {five ? <Meter label="5-hour" pct={five.pct} note={five.note} title={five.title} /> : null}
          {week ? <Meter label="weekly" pct={week.pct} note={week.note} title={week.title} /> : null}
          {stale ? (
            <span
              style={{ color: C.faint, whiteSpace: 'nowrap' }}
              title="Claude reports these when a session finishes a turn, so they only move then."
            >
              as of {agoText(age)} ago
            </span>
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
