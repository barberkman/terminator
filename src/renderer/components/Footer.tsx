import { C, STATUS_COLORS, STATUS_LABELS, dotStyle } from '../theme'
import { useStore } from '../state/store'

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
  const usagePct = session?.metrics?.usagePct
  const weeklyPct = session?.metrics?.weeklyUsagePct
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>
        <span style={{ fontSize: 9.5, letterSpacing: 0.6, color: C.dim, fontWeight: 700 }}>USAGE</span>
        {usagePct != null || weeklyPct != null ? (
          <>
            {usagePct != null ? <Meter label="5-hour" pct={usagePct} /> : null}
            {weeklyPct != null ? <Meter label="weekly" pct={weeklyPct} /> : null}
          </>
        ) : (
          <span style={{ color: C.faint }}>—</span>
        )}
      </div>
    </div>
  )
}
