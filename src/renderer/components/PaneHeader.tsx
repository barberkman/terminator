import { useRef, useState } from 'react'
import type { Session } from '../../shared/types'
import { C, STATUS_COLORS, STATUS_LABELS, accentA, ink, dotStyle, sz } from '../theme'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import * as registry from '../term/registry'

function iconBtn(extra?: React.CSSProperties): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: sz(30),
    height: sz(30),
    borderRadius: 7,
    border: `1px solid ${C.border2}`,
    background: 'transparent',
    color: C.textSubtle,
    cursor: 'pointer',
    ...extra,
  }
}

function Metric({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 9, letterSpacing: 0.6, color: C.dim, fontWeight: 700 }}>{label}</span>
      <div style={{ fontSize: 12, color: C.textStrong, whiteSpace: 'nowrap' }}>{children}</div>
    </div>
  )
}

// Slash-command aliases sent into the live Claude session via writePty.
const MODEL_OPTIONS = ['fable', 'opus', 'sonnet', 'haiku'] as const
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Click-to-open picker for a header metric (model/effort). Selecting an option
 * fires onPick; the displayed value comes from Claude's statusLine report, so it
 * refreshes itself after the slash command applies. Modeled on Sidebar's LayoutMenu.
 */
function MetricPicker({
  value,
  options,
  isActive,
  disabled,
  onPick,
  prefix,
}: {
  value: string
  options: readonly string[]
  isActive: (opt: string) => boolean
  disabled?: boolean
  onPick: (opt: string) => void
  prefix?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  if (disabled) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        {prefix}
        {value}
      </span>
    )
  }

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 6px',
          margin: '-2px -6px',
          borderRadius: 6,
          border: '1px solid transparent',
          background: open ? C.hover : 'transparent',
          color: C.textStrong,
          font: 'inherit',
          fontSize: 12,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = C.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = open ? C.hover : 'transparent')}
      >
        {prefix}
        {value}
        <span style={{ display: 'flex', color: C.muted, flex: 'none' }}>
          <Icon name="chevron" size={12} />
        </span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
          <div
            style={{
              position: 'absolute',
              top: 26,
              left: 0,
              zIndex: 31,
              minWidth: 132,
              padding: 5,
              background: C.panel,
              border: `1px solid ${C.border3}`,
              borderRadius: 10,
              boxShadow: C.shadowMenu,
              animation: 'cc-fade 0.12s ease',
            }}
          >
            {options.map((opt) => {
              const active = isActive(opt)
              return (
                <div
                  key={opt}
                  onClick={() => {
                    onPick(opt)
                    setOpen(false)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '7px 9px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    color: active ? C.textHi : C.body,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = C.hover)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ flex: 1, fontSize: 12.5 }}>{opt}</span>
                  {active && (
                    <span style={{ display: 'flex', color: C.accent, flex: 'none' }}>
                      <Icon name="check" size={14} />
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

export function PaneHeader({ session, active }: { session: Session; active: boolean }): React.JSX.Element {
  const editing = useStore((s) => s.editingId === session.id)
  const startEdit = useStore((s) => s.startEdit)
  const setConfirm = useStore((s) => s.setConfirm)
  const setBranchFor = useStore((s) => s.setBranchFor)
  const openSession = useStore((s) => s.openSession)
  const showTranscript = useStore((s) => !!s.transcripts[session.id])
  const toggleTranscript = useStore((s) => s.toggleTranscript)
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

  // Leaving the conversation hands the keyboard back to the terminal, which the
  // view had taken it from so nothing could be typed into a covered pane.
  const toggleView = () => {
    toggleTranscript(session.id)
    if (showTranscript) registry.focus(session.id)
  }

  // Inject a /model|/effort change into the live session and optimistically reflect
  // it in the header. Claude only re-runs its statusLine (our metrics source) after
  // an assistant message, not after these slash commands, so without this the header
  // value would stay stale until the next turn. The next statusLine report corrects it.
  const pickMetric = (kind: 'model' | 'effort', opt: string) => {
    window.terminator.writePty(session.id, `/${kind} ${opt}\r`)
    const store = useStore.getState()
    const cur = store.sessions[session.id]
    if (cur) store.upsert({ ...cur, metrics: { ...cur.metrics, [kind]: opt } })
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '11px 14px',
        borderBottom: `1px solid ${C.border}`,
        // The pane's chrome strip, on the app dial rather than the terminal one.
        // The focused wash rides over it as an image so it stays one element and
        // one ground.
        backgroundColor: C.glassGround,
        backgroundImage: active ? `linear-gradient(${ink(0.02)}, ${ink(0.02)})` : undefined,
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
                background: ink(0.06),
                border: `1px solid ${accentA(0.45)}`,
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
              background: ink(0.05),
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
          {!!session.branchedFrom && (
            <>
              <span style={{ color: C.faint2 }}>·</span>
              <span
                onClick={() => session.parentId && openSession(session.parentId)}
                title={
                  session.parentId
                    ? `Branched from ${session.branchedFrom} — click to open it`
                    : `Branched from ${session.branchedFrom} (since removed)`
                }
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  color: C.accentSoft,
                  cursor: session.parentId ? 'pointer' : 'default',
                }}
              >
                <Icon name="branch" size={11} />
                from {session.branchedFrom}
                {session.branchPoint !== undefined &&
                  (session.branchPoint > 0 ? ` · after prompt ${session.branchPoint}` : ' · from the start')}
              </span>
            </>
          )}
        </div>
      </div>

      {isClaude && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flex: 'none' }}>
            <Metric label="MODEL">
              <MetricPicker
                value={m?.model ?? '—'}
                options={MODEL_OPTIONS}
                isActive={(opt) => !!m?.model && m.model.toLowerCase().includes(opt)}
                disabled={!session.alive}
                onPick={(opt) => pickMetric('model', opt)}
                prefix={<span style={{ ...dotStyle('idle', 6), background: C.accent, animation: undefined }} />}
              />
            </Metric>
            <Metric label="EFFORT">
              <MetricPicker
                value={m?.effort ?? '—'}
                options={EFFORT_OPTIONS}
                isActive={(opt) => m?.effort?.toLowerCase() === opt}
                disabled={!session.alive}
                onPick={(opt) => pickMetric('effort', opt)}
              />
            </Metric>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 108 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 9, letterSpacing: 0.6, color: C.dim, fontWeight: 700 }}>CONTEXT</span>
                <span style={{ fontSize: 9, color: C.muted }}>
                  {m?.contextPct != null ? `${Math.round(m.contextPct)}%` : '—'}
                </span>
              </div>
              <span style={{ fontSize: 12, color: C.textStrong, whiteSpace: 'nowrap' }}>
                {m?.contextTokens != null ? `${(m.contextTokens / 1000).toFixed(1)}k tokens` : '—'}
              </span>
              <div style={{ height: 3, borderRadius: 2, background: ink(0.1), overflow: 'hidden' }}>
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
          <div style={{ width: 1, height: 34, background: ink(0.08), flex: 'none' }} />
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
        {isClaude && (
          <button
            onClick={toggleMode}
            title={session.mode === 'readonly' ? 'Read-only — click to allow edits' : 'Switch to read-only'}
            style={iconBtn({ color: session.mode === 'readonly' ? C.accentSoft : C.textSubtle })}
          >
            <Icon name={session.mode === 'readonly' ? 'lock' : 'unlock'} size={15} />
          </button>
        )}
        {isClaude && (
          <button
            onClick={toggleView}
            title={showTranscript ? 'Back to the live terminal' : 'Read this conversation, with copy buttons on every code block'}
            style={iconBtn(
              showTranscript
                ? { color: C.accentSoft, borderColor: C.accentBorder, background: C.accentBg }
                : undefined,
            )}
          >
            <Icon name={showTranscript ? 'terminal' : 'note'} size={15} />
          </button>
        )}
        {isClaude && (
          <button
            onClick={() => setBranchFor(session.id)}
            title="Branch this conversation from an earlier prompt"
            style={iconBtn()}
          >
            <Icon name="branch" size={15} />
          </button>
        )}
        <button onClick={() => void window.terminator.openInFolder(session.id)} title="Open folder in file manager" style={iconBtn()}>
          <Icon name="folder" size={15} />
        </button>
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
