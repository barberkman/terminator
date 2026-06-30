import { useRef, useState } from 'react'
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
      <div style={{ fontSize: 12, color: '#d6d1c4', whiteSpace: 'nowrap' }}>{children}</div>
    </div>
  )
}

// Slash-command aliases sent into the live Claude session via writePty.
const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku'] as const
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
          color: '#d6d1c4',
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
              boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
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
  const settings = useStore((s) => s.settings)
  const inputRef = useRef<HTMLInputElement>(null)

  const isClaude = session.kind === 'claude'
  const m = session.metrics
  const buildCmd = settings?.buildCommand.trim()
  const runCmd = settings?.runCommand.trim()

  // Build/Run use a single dedicated, reusable interactive terminal per task (in
  // their own "Tasks" group). First click creates it; later clicks reuse it and
  // just type the command at its prompt, so it stays usable after the run finishes.
  const runTask = async (task: 'build' | 'run') => {
    const store = useStore.getState()
    let target = Object.values(store.sessions).find((x) => x.task === task)
    if (!target) {
      target = await window.terminator.createSession({
        kind: 'shell',
        mode: 'normal',
        task,
        name: task === 'build' ? 'Build' : 'Run',
        projectName: 'Tasks',
        projectPath: session.worktreePath || session.projectPath,
      })
      store.upsert(target)
    }
    store.openSession(target.id)
    await window.terminator.runTaskCommand(target.id, task)
  }

  const commit = () => {
    const v = inputRef.current?.value.trim()
    if (v) void window.terminator.renameSession(session.id, v)
    startEdit(null)
  }

  const toggleMode = () => {
    void window.terminator.setMode(session.id, session.mode === 'readonly' ? 'normal' : 'readonly')
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
        <button
          onClick={() => void runTask('build')}
          disabled={!buildCmd}
          title={buildCmd ? 'Build — run in the Build terminal' : 'Set a build command in Settings'}
          style={iconBtn(buildCmd ? undefined : { opacity: 0.4, cursor: 'default' })}
        >
          <Icon name="hammer" size={15} />
        </button>
        <button
          onClick={() => void runTask('run')}
          disabled={!runCmd}
          title={runCmd ? 'Run — run in the Run terminal' : 'Set a run command in Settings'}
          style={iconBtn(runCmd ? undefined : { opacity: 0.4, cursor: 'default' })}
        >
          <Icon name="play" size={15} />
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
