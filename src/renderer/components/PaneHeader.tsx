import { useRef } from 'react'
import type { Session } from '../../shared/types'
import { C, STATUS_COLORS, STATUS_LABELS, dotStyle } from '../theme'
import { Icon } from '../icons'
import { useStore } from '../state/store'

function iconBtn(extra?: React.CSSProperties): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: 7,
    border: `1px solid ${C.border2}`,
    background: 'transparent',
    color: '#9a958a',
    cursor: 'pointer',
    ...extra,
  }
}

function Metric({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 9, letterSpacing: 0.6, color: C.dim, fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 12, color: '#d6d1c4', whiteSpace: 'nowrap' }}>{children}</span>
    </div>
  )
}

export function PaneHeader({ session, active }: { session: Session; active: boolean }): React.JSX.Element {
  const editing = useStore((s) => s.editingId === session.id)
  const startEdit = useStore((s) => s.startEdit)
  const setConfirm = useStore((s) => s.setConfirm)
  const inputRef = useRef<HTMLInputElement>(null)

  const isClaude = session.kind === 'claude'
  const m = session.metrics

  const commit = () => {
    const v = inputRef.current?.value.trim()
    if (v) void window.terminator.renameSession(session.id, v)
    startEdit(null)
  }

  const toggleMode = () => {
    void window.terminator.setMode(session.id, session.mode === 'readonly' ? 'normal' : 'readonly')
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '11px 14px',
        borderBottom: `1px solid ${C.border}`,
        background: active ? 'rgba(214,209,196,0.02)' : 'transparent',
      }}
    >
      <span style={dotStyle(session.status, 9)} />

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 3 }}>
          {editing ? (
            <input
              ref={inputRef}
              defaultValue={session.name}
              autoFocus
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                else if (e.key === 'Escape') startEdit(null)
              }}
              style={{
                background: 'rgba(214,209,196,0.06)',
                border: `1px solid rgba(217,119,87,0.45)`,
                borderRadius: 5,
                color: C.textMax,
                font: 'inherit',
                fontSize: 14.5,
                fontWeight: 600,
                padding: '2px 7px',
                outline: 'none',
                maxWidth: 300,
              }}
            />
          ) : (
            <span
              onDoubleClick={() => startEdit(session.id)}
              title="Double-click to rename"
              style={{
                fontSize: 14.5,
                fontWeight: 600,
                color: C.textMax,
                borderBottom: '1px solid transparent',
                cursor: 'text',
                whiteSpace: 'nowrap',
              }}
            >
              {session.name}
            </span>
          )}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 8px',
              borderRadius: 20,
              fontSize: 11,
              fontWeight: 600,
              color: STATUS_COLORS[session.status],
              background: 'rgba(214,209,196,0.05)',
            }}
          >
            <span style={dotStyle(session.status, 6)} />
            {STATUS_LABELS[session.status]}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 11.5,
            color: C.muted,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <span>{session.projectName}</span>
          <span style={{ color: C.faint2 }}>/</span>
          <span>{session.branch}</span>
          <span style={{ color: C.faint2 }}>·</span>
          <span>{session.activity}</span>
        </div>
      </div>

      {isClaude && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flex: 'none' }}>
            <Metric label="MODEL">
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ ...dotStyle('idle', 6), background: C.accent, animation: undefined }} />
                {m?.model ?? '—'}
              </span>
            </Metric>
            <Metric label="EFFORT">{m?.effort ?? '—'}</Metric>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 108 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 9, letterSpacing: 0.6, color: C.dim, fontWeight: 700 }}>CONTEXT</span>
                <span style={{ fontSize: 9, color: C.muted }}>
                  {m?.contextPct != null ? `${Math.round(m.contextPct)}%` : '—'}
                </span>
              </div>
              <span style={{ fontSize: 12, color: '#d6d1c4', whiteSpace: 'nowrap' }}>
                {m?.contextTokens != null ? `${(m.contextTokens / 1000).toFixed(1)}k tokens` : '—'}
              </span>
              <div style={{ height: 3, borderRadius: 2, background: 'rgba(214,209,196,0.1)', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(100, m?.contextPct ?? 0)}%`,
                    background: C.accent,
                  }}
                />
              </div>
            </div>
          </div>
          <div style={{ width: 1, height: 34, background: 'rgba(214,209,196,0.08)', flex: 'none' }} />
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
        {isClaude && (
          <button
            onClick={toggleMode}
            title={session.mode === 'readonly' ? 'Read-only — click to allow edits' : 'Switch to read-only'}
            style={iconBtn({ color: session.mode === 'readonly' ? C.accentSoft : '#9a958a' })}
          >
            <Icon name={session.mode === 'readonly' ? 'lock' : 'unlock'} size={15} />
          </button>
        )}
        <button onClick={() => void window.terminator.openGitGui(session.id)} title="Open folder in git tool" style={iconBtn()}>
          <Icon name="git" size={15} />
        </button>
        <button
          onClick={() => setConfirm({ kind: 'close', id: session.id, name: session.name })}
          title="Close session"
          style={iconBtn()}
        >
          <Icon name="power" size={15} />
        </button>
      </div>
    </div>
  )
}
