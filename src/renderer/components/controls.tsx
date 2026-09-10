import { C, accentA } from '../theme'
import { Icon } from '../icons'

// The form vocabulary the two settings surfaces share. These all began life as
// private helpers inside SettingsView; they moved here when the theme editor
// needed the same shapes, and nothing about them changed on the way.

export const inputStyle: React.CSSProperties = {
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

export const smallBtn: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: 7,
  border: `1px solid ${C.border2}`,
  background: 'transparent',
  color: C.muted,
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
  flex: 'none',
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, letterSpacing: 0.5, color: C.muted, fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10.5, color: C.dim, marginTop: 5 }}>{hint}</div>}
    </div>
  )
}

/** A two-option toggle, the shape Settings already uses for its either/ors. */
export function Choice<T extends string | number | boolean>({
  options,
  value,
  onPick,
}: {
  options: { value: T; label: string }[]
  value: T
  onPick: (v: T) => void
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {options.map((o) => {
        const on = value === o.value
        return (
          <button
            key={String(o.value)}
            onClick={() => onPick(o.value)}
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 8,
              border: `1px solid ${on ? C.accentBorder : C.border2}`,
              background: on ? accentA(0.12) : 'transparent',
              color: on ? C.accentSoft : C.muted,
              font: 'inherit',
              fontSize: 12.5,
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A foldable group of fields. Controlled — Settings keeps its open/closed map in
 * `settings.settingsOpen` so it survives a restart, while the theme editor keeps
 * its own in component state; neither needs this component to know which.
 *
 * The header is the sidebar's project-group row (Sidebar.tsx), down to the
 * chevron's quarter-turn, because a disclosure should read the same everywhere in
 * the app. `summary` is what the section says when it's shut, which is the whole
 * point of shutting it — and `actions` are the buttons that shouldn't need it
 * open to reach.
 */
export function Section({
  label,
  summary,
  actions,
  open,
  onToggle,
  children,
}: {
  label: string
  summary?: React.ReactNode
  actions?: React.ReactNode
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 0 8px', cursor: 'pointer' }}
      >
        <span
          style={{
            display: 'flex',
            color: C.muted,
            transform: open ? 'none' : 'rotate(-90deg)',
            transition: 'transform 0.12s ease',
          }}
        >
          <Icon name="chevron" size={12} />
        </span>
        <span style={{ fontSize: 11, letterSpacing: 0.5, color: C.textSubtle, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {!open && summary !== undefined && (
          <span
            style={{
              fontSize: 11,
              color: C.dim,
              marginLeft: 4,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {summary}
          </span>
        )}
        <span style={{ flex: 1, height: 1, background: C.hair, minWidth: 8 }} />
        {actions && (
          // The buttons sit on the header, so their clicks must not also fold it.
          <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 6, flex: 'none' }}>
            {actions}
          </span>
        )}
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '2px 0 14px' }}>{children}</div>
      )}
    </div>
  )
}
