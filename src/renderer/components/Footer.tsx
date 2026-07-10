import { useEffect, useState } from 'react'
import { C, STATUS_COLORS, STATUS_LABELS, dotStyle } from '../theme'
import { useStore } from '../state/store'

/** "2h 14m left" (or "14m left") until the ISO reset, or null if past/invalid. */
function timeLeft(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null
  const t = new Date(resetsAt).getTime()
  if (!Number.isFinite(t)) return null
  const diff = t - now
  if (diff <= 0) return null
  const totalMin = Math.floor(diff / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`
}

/** Local wall-clock time the window resets at, e.g. "14:30", or null. */
function resetClock(resetsAt: string | undefined): string | null {
  if (!resetsAt) return null
  const t = new Date(resetsAt).getTime()
  if (!Number.isFinite(t)) return null
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function Meter({ label, pct }: { label: string; pct: number }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 'none' }}>
      <span style={{ color: C.muted, whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ width: 70, height: 4, borderRadius: 2, background: 'rgba(214,209,196,0.1)', overflow: 'hidden', flex: 'none' }}>
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, pct)}%`,
            background: pct > 85 ? STATUS_COLORS.error : C.accent,
          }}
        />
      </div>
      <span style={{ color: C.textHi, fontWeight: 600, whiteSpace: 'nowrap' }}>{Math.round(pct)}%</span>
    </div>
  )
}

export function Footer(): React.JSX.Element {
  const focusedId = useStore((s) => s.panes[s.focused])
  const session = useStore((s) => (focusedId ? s.sessions[focusedId] : undefined))
  // Usage is account-wide (global), not tied to the focused session.
  const usage = useStore((s) => s.usage)
  const refreshSeconds = useStore((s) => s.settings?.usageRefreshSeconds) ?? 30
  const cwd = session ? session.worktreePath || session.projectPath : ''

  // Periodically re-render so the reset countdown stays live even when Claude
  // isn't reporting. Interval configurable via Settings → Usage Refresh.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const ms = Math.max(1, refreshSeconds) * 1000
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [refreshSeconds])

  const hasUsage = usage.updatedAt != null
  const fiveHourPct = usage.fiveHourPct
  const weeklyPct = usage.weeklyPct
  const fiveHourLeft = timeLeft(usage.fiveHourResetsAt, now)
  const fiveHourReset = resetClock(usage.fiveHourResetsAt)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        height: 40,
        flex: 'none',
        padding: '0 16px',
        // Match the sidebar surface (not the darker C.footer) so the strip under
        // the sidebar blends in rather than reading as an empty black rectangle
        // glued to the bottom of the session list.
        background: C.sidebar,
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>
        <span style={{ fontSize: 9.5, letterSpacing: 0.6, color: C.dim, fontWeight: 700 }}>USAGE</span>
        {hasUsage ? (
          <>
            {fiveHourPct != null ? <Meter label="5-hour" pct={fiveHourPct} /> : null}
            {fiveHourLeft ? (
              <span style={{ color: C.muted, whiteSpace: 'nowrap' }}>
                <span style={{ color: C.textHi, fontWeight: 600 }}>{fiveHourLeft}</span>
                {fiveHourReset ? <span style={{ color: C.faint2 }}> · resets {fiveHourReset}</span> : null}
              </span>
            ) : null}
            {weeklyPct != null ? <Meter label="weekly" pct={weeklyPct} /> : null}
          </>
        ) : (
          <span style={{ color: C.faint }}>—</span>
        )}
      </div>
    </div>
  )
}
