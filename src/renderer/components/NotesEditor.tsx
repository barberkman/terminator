import { useState } from 'react'
import { C, FONT, accentA, sz } from '../theme'
import { Icon } from '../icons'
import { renderMarkdown } from '../markdown'

const textareaStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  resize: 'none',
  padding: '12px 14px',
  background: C.input,
  border: `1px solid ${C.border2}`,
  borderRadius: 8,
  color: C.textHi,
  fontFamily: FONT,
  fontSize: 12.5,
  lineHeight: 1.55,
  outline: 'none',
}

function ToggleButton({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px',
        borderRadius: 7,
        border: `1px solid ${on ? C.accentBorder : C.border2}`,
        background: on ? accentA(0.12) : 'transparent',
        color: on ? C.accentSoft : C.muted,
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

export function NotesEditor({
  value,
  onChange,
  onSave,
  onClose,
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onClose: () => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'edit' | 'preview'>('preview')

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: C.scrim,
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'cc-fade 0.18s ease',
      }}
    >
      <div
        style={{
          width: 760,
          maxWidth: '94vw',
          height: '82vh',
          display: 'flex',
          flexDirection: 'column',
          background: C.panel,
          border: `1px solid ${C.border3}`,
          borderRadius: 14,
          boxShadow: C.shadowModal,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '16px 20px 14px' }}>
          <span style={{ display: 'flex', color: C.accent }}>
            <Icon name="sparkle" size={16} />
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.textMax }}>Notes</span>
          <div style={{ display: 'flex', gap: 8, marginLeft: 14 }}>
            <ToggleButton on={mode === 'edit'} label="Edit" onClick={() => setMode('edit')} />
            <ToggleButton on={mode === 'preview'} label="Preview" onClick={() => setMode('preview')} />
          </div>
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', display: 'flex', width: sz(26), height: sz(26), alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer' }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, padding: '0 20px', overflow: 'hidden' }}>
          {mode === 'edit' ? (
            <textarea
              autoFocus
              spellCheck={false}
              placeholder="# Notes&#10;&#10;Write markdown here. Use `inline code` and fenced ``` blocks — they get copy buttons in Preview."
              style={textareaStyle}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <div className="md-body" style={{ height: '100%', overflowY: 'auto', padding: '0 4px 8px' }}>
              {value.trim() ? (
                renderMarkdown(value)
              ) : (
                <div style={{ color: C.dim, fontSize: 12.5, paddingTop: 8 }}>Nothing to preview yet.</div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '16px 20px 20px' }}>
          <button onClick={onClose} style={{ padding: '10px 18px', background: 'transparent', border: `1px solid ${C.border3}`, borderRadius: 9, color: C.textBtn, font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>
            Close
          </button>
          <button onClick={onSave} style={{ padding: '10px 20px', background: C.accent, border: 'none', borderRadius: 9, color: C.accentText, font: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
