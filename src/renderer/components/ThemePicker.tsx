import { allPalettes, type ThemeGroup, type ThemePalette } from '../../shared/themes'
import { C } from '../theme'
import { Icon } from '../icons'
import { useStore } from '../state/store'

const GROUP_LABELS: Record<ThemeGroup, string> = {
  custom: 'YOURS',
  dark: 'DARK',
  light: 'LIGHT',
  reading: 'READING',
}

// The user's own first: they're the ones with a reason to be looked for.
const GROUP_ORDER: ThemeGroup[] = ['custom', 'dark', 'light', 'reading']

/**
 * One theme, painted in its own colours. Everything here reads literal values off
 * the palette rather than the `C` tokens — the CSS variables hold the *active*
 * theme, and a swatch has to show the theme it offers, not the one in force.
 */
function Swatch({
  palette,
  selected,
  onPick,
  onEdit,
}: {
  palette: ThemePalette
  selected: boolean
  onPick: () => void
  onEdit?: () => void
}): React.JSX.Element {
  return (
    // The pencil can't nest inside the swatch (a button in a button), so the card
    // is a positioned wrapper holding the two of them side by side.
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        onClick={onPick}
        title={palette.name}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          padding: '12px 6px 9px',
          borderRadius: 10,
          cursor: 'pointer',
          background: palette.bg,
          backgroundImage: palette.texture,
          border: `2px solid ${selected ? palette.accent : palette.panel2}`,
          boxShadow: selected ? `0 0 0 2px rgba(${palette.accentRgb},0.28)` : 'none',
          font: 'inherit',
          overflow: 'hidden',
        }}
      >
        <span style={{ fontSize: 19, lineHeight: 1.1, color: palette.textMax, fontWeight: palette.uiWeight }}>
          Aa
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: palette.muted,
            fontWeight: palette.uiWeight,
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {palette.name}
        </span>
        <span style={{ display: 'flex', gap: 4, marginTop: 3 }}>
          {[palette.status.busy, palette.status.waiting, palette.status.idle].map((c) => (
            <span key={c} style={{ width: 5, height: 5, borderRadius: '50%', background: c }} />
          ))}
        </span>
      </button>
      {onEdit && (
        <button
          onClick={onEdit}
          title={`Edit ${palette.name}`}
          style={{
            position: 'absolute',
            top: 3,
            right: 3,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            borderRadius: 6,
            border: 'none',
            // Painted in the offered theme's own colours, like everything else here.
            background: `rgba(${palette.bgRgb},0.6)`,
            color: palette.muted,
            cursor: 'pointer',
          }}
        >
          <Icon name="pencil" size={11} />
        </button>
      )}
    </div>
  )
}

/**
 * The theme grid. Picking applies the theme straight away rather than waiting for
 * Save — a set of swatches you can't see in place isn't much of a preview.
 * SettingsView reverts to the saved theme if the modal is closed without saving.
 */
export function ThemePicker({
  value,
  onPick,
  onEdit,
}: {
  value: string
  onPick: (id: string) => void
  /** Opens the theme editor. Offered on the user's own themes only. */
  onEdit: (id: string) => void
}): React.JSX.Element {
  // Subscribed for the re-render; the palettes themselves come from the shared
  // registry, which `setCustomThemes` keeps in step with this list.
  useStore((s) => s.customThemes)
  const palettes = allPalettes()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {GROUP_ORDER.map((group) => {
        const themes = palettes.filter((t) => t.group === group)
        if (themes.length === 0) return null
        return (
          <div key={group}>
            <div style={{ fontSize: 9.5, letterSpacing: 0.6, color: C.faint, fontWeight: 600, marginBottom: 6 }}>
              {GROUP_LABELS[group]}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {themes.map((t) => (
                <Swatch
                  key={t.id}
                  palette={t}
                  selected={t.id === value}
                  onPick={() => onPick(t.id)}
                  onEdit={t.group === 'custom' ? () => onEdit(t.id) : undefined}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
