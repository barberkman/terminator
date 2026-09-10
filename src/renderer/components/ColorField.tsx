import { useEffect, useState } from 'react'
import { COLOR_RE, type ContrastWarning } from '../../shared/themes'
import { C } from '../theme'

/** `#abc` → `#aabbcc`. The native colour input only accepts the long form. */
function full(hex: string): string {
  const h = hex.replace('#', '')
  return `#${(h.length === 3 ? h.replace(/./g, (c) => c + c) : h).toLowerCase()}`
}

/**
 * One colour in the theme editor.
 *
 * The text box holds whatever you type and only commits when it's a hex colour —
 * a half-typed `#ab` or an outright typo colours its own border and goes no
 * further, which is the first of the three places a bad value is stopped (the
 * other two being `sanitizeSeed` on the way to disk and the hardened `parse` in
 * the palette builder).
 *
 * `derived` marks a field that has a value even when you leave it alone: the five
 * surfaces, the nine middle ramp steps, the cursor and the selection. Those show
 * their derived colour greyed out until you touch them, and can be handed back to
 * the derivation afterwards — every pin here is reversible.
 */
export function ColorField({
  label,
  value,
  derived,
  pinned,
  warning,
  onChange,
  onUnpin,
}: {
  label: string
  value: string
  /** The colour derivation would produce. Omit for a field that has no derivation. */
  derived?: string
  pinned?: boolean
  warning?: ContrastWarning
  onChange: (hex: string) => void
  onUnpin?: () => void
}): React.JSX.Element {
  const [text, setText] = useState(value)
  // Follows the theme when the value moves for some other reason — an unpin, an
  // import, a change to the colour this one is derived from.
  useEffect(() => setText(value), [value])

  const trimmed = text.trim()
  const bad = trimmed !== '' && !COLOR_RE.test(trimmed)
  const derivable = derived !== undefined
  const off = derivable && !pinned

  const commit = (next: string) => {
    setText(next)
    if (COLOR_RE.test(next.trim())) onChange(full(next.trim()))
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <input
        type="color"
        value={full(value)}
        onChange={(e) => commit(e.target.value)}
        title={label}
        style={{
          width: 26,
          height: 26,
          flex: 'none',
          padding: 0,
          border: `1px solid ${warning ? C.danger : C.border3}`,
          borderRadius: 7,
          background: 'transparent',
          cursor: 'pointer',
          opacity: off ? 0.5 : 1,
        }}
      />
      <input
        value={text}
        spellCheck={false}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setText(value)}
        style={{
          width: 82,
          flex: 'none',
          padding: '5px 7px',
          background: C.input,
          border: `1px solid ${bad ? C.danger : C.border2}`,
          borderRadius: 7,
          color: off ? C.dim : C.textHi,
          font: 'inherit',
          fontSize: 11.5,
          outline: 'none',
        }}
      />
      <span
        style={{
          fontSize: 11,
          color: off ? C.dim : C.body,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {derivable && (
        <span style={{ marginLeft: 'auto', flex: 'none' }}>
          {pinned ? (
            <button
              onClick={onUnpin}
              title="Go back to the derived value"
              style={{
                padding: '3px 7px',
                borderRadius: 6,
                border: `1px solid ${C.border2}`,
                background: 'transparent',
                color: C.muted,
                font: 'inherit',
                fontSize: 10,
                cursor: 'pointer',
              }}
            >
              unpin
            </button>
          ) : (
            <span style={{ fontSize: 10, color: C.faint }}>derived</span>
          )}
        </span>
      )}
    </div>
  )
}

/** The readability notes for one section of the editor, worst first. */
export function ContrastNotes({ warnings }: { warnings: ContrastWarning[] }): React.JSX.Element | null {
  if (warnings.length === 0) return null
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '8px 10px',
        borderRadius: 8,
        border: `1px solid rgba(var(--c-status-waiting-rgb),0.35)`,
        background: `rgba(var(--c-status-waiting-rgb),0.09)`,
        fontSize: 10.5,
        color: C.body,
      }}
    >
      {warnings.map((w) => (
        <div key={w.label}>
          {w.label} is <strong style={{ fontWeight: 600 }}>{w.ratio.toFixed(1)}:1</strong> — under the {w.need}:1 it
          needs to stay readable.
        </div>
      ))}
    </div>
  )
}
