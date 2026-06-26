import { useEffect, useState } from 'react'
import type { NotifType, Settings } from '../../shared/types'
import { C } from '../theme'
import { Icon } from '../icons'
import { useStore } from '../state/store'

const NOTIF_TYPES: NotifType[] = ['waiting', 'finished', 'error', 'exited']

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  background: C.input,
  border: `1px solid ${C.border2}`,
  borderRadius: 8,
  color: C.textHi,
  font: 'inherit',
  fontSize: 12.5,
  outline: 'none',
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, letterSpacing: 0.5, color: C.muted, fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10.5, color: C.dim, marginTop: 5 }}>{hint}</div>}
    </div>
  )
}

export function SettingsView(): React.JSX.Element | null {
  const show = useStore((s) => s.showSettings)
  const setShow = useStore((s) => s.setShowSettings)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const [draft, setDraft] = useState<Settings | null>(settings)

  useEffect(() => {
    if (show) setDraft(settings)
  }, [show, settings])

  if (!show || !draft) return null

  const patch = (p: Partial<Settings>) => setDraft({ ...draft, ...p })
  const save = async () => {
    const result = await window.terminator.updateSettings(draft)
    setSettings(result)
    setShow(false)
  }

  const toggleTrigger = (t: NotifType) => {
    const cur = draft.notifications.triggerOn
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]
    patch({ notifications: { ...draft.notifications, triggerOn: next } })
  }

  return (
    <div
      onClick={() => setShow(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(10,9,8,0.66)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'cc-fade 0.18s ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 540,
          maxWidth: '94vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: C.panel,
          border: `1px solid ${C.border3}`,
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '18px 20px 14px' }}>
          <span style={{ display: 'flex', color: C.accent }}>
            <Icon name="settings" size={16} />
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.textMax }}>Settings</span>
          <button
            onClick={() => setShow(false)}
            style={{ marginLeft: 'auto', display: 'flex', width: 26, height: 26, alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer' }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>

        <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="CLAUDE COMMAND" hint="Run for a normal Claude session. The app appends --session-id / --resume / --settings.">
            <input style={inputStyle} value={draft.modes.normal.command} onChange={(e) => patch({ modes: { ...draft.modes, normal: { ...draft.modes.normal, command: e.target.value } } })} />
          </Field>
          <Field label="CLAUDE READ-ONLY COMMAND" hint={'Must forward appended args (e.g. exec claude --some-flag "$@").'}>
            <input style={inputStyle} value={draft.modes.readonly.command} onChange={(e) => patch({ modes: { ...draft.modes, readonly: { ...draft.modes.readonly, command: e.target.value } } })} />
          </Field>
          <Field label="DEFAULT SHELL" hint="Used for plain terminals and to resolve commands.">
            <input style={inputStyle} value={draft.defaultShell} onChange={(e) => patch({ defaultShell: e.target.value })} />
          </Field>
          <Field label="GIT GUI COMMAND" hint="Launched with a session's folder by the git button. App never merges.">
            <input style={inputStyle} value={draft.gitGuiCommand} onChange={(e) => patch({ gitGuiCommand: e.target.value })} />
          </Field>
          <Field label="WORKTREES ROOT" hint="Where new git worktrees are created.">
            <input style={inputStyle} value={draft.worktreesRoot} onChange={(e) => patch({ worktreesRoot: e.target.value })} />
          </Field>

          <div style={{ height: 1, background: C.hair, margin: '2px 0' }} />

          <Field label="TERMINAL FONT" hint="Font family for the terminal panes (the app chrome uses JetBrains Mono).">
            <input
              style={inputStyle}
              list="term-fonts"
              value={draft.terminalFont}
              onChange={(e) => patch({ terminalFont: e.target.value })}
            />
            <datalist id="term-fonts">
              <option value="'JetBrains Mono', monospace" />
              <option value="'Fira Code', monospace" />
              <option value="'Cascadia Code', monospace" />
              <option value="'Source Code Pro', monospace" />
              <option value="Menlo, monospace" />
              <option value="Consolas, monospace" />
              <option value="'Ubuntu Mono', monospace" />
              <option value="monospace" />
            </datalist>
          </Field>
          <Field label="FONT SIZE" hint="Scales the whole interface — sidebar, tabs, and terminals. 14 = default.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="range"
                min={9}
                max={26}
                step={1}
                value={draft.fontSize}
                onChange={(e) => patch({ fontSize: Number(e.target.value) || draft.fontSize })}
                style={{ flex: 1, accentColor: C.accent }}
              />
              <input
                type="number"
                min={9}
                max={26}
                style={{ ...inputStyle, width: 70, flex: 'none' }}
                value={draft.fontSize}
                onChange={(e) => patch({ fontSize: Number(e.target.value) || draft.fontSize })}
              />
            </div>
          </Field>

          <Field label="NOTIFICATION COMMAND" hint="Run on each notification, via your shell. Receives the event as JSON on stdin and TERMINATOR_* env vars. Leave blank to disable.">
            <input style={inputStyle} placeholder="python3 ~/notify.py" value={draft.notifications.command} onChange={(e) => patch({ notifications: { ...draft.notifications, command: e.target.value } })} />
          </Field>
          <Field label="RUN COMMAND ON">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {NOTIF_TYPES.map((t) => {
                const on = draft.notifications.triggerOn.includes(t)
                return (
                  <button
                    key={t}
                    onClick={() => toggleTrigger(t)}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 7,
                      border: `1px solid ${on ? C.accentBorder : C.border2}`,
                      background: on ? 'rgba(217,119,87,0.12)' : 'transparent',
                      color: on ? C.accentSoft : C.muted,
                      font: 'inherit',
                      fontSize: 12,
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                    }}
                  >
                    {t}
                  </button>
                )
              })}
            </div>
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '18px 20px 20px', marginTop: 6 }}>
          <button onClick={() => setShow(false)} style={{ padding: '10px 18px', background: 'transparent', border: `1px solid ${C.border3}`, borderRadius: 9, color: '#b4afa3', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={save} style={{ padding: '10px 20px', background: C.accent, border: 'none', borderRadius: 9, color: C.accentText, font: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
            Save settings
          </button>
        </div>
      </div>
    </div>
  )
}
