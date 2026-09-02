import type { SessionStatus } from '../shared/types'

/**
 * Colour tokens. Every value is a reference to a CSS custom property rather than
 * a literal, so the ~350 inline `style={{}}` sites that read `C` repaint the
 * moment a theme is applied — no React re-render, no prop drilling. The
 * properties themselves are written by `applyTheme()` (theme-apply.ts) from the
 * palettes in shared/themes.ts; `styles.css` carries the default theme as static
 * `:root` fallbacks so the very first paint is already right.
 *
 * Alpha tints are mixed from the `*-rgb` triplets through the helpers below
 * instead of getting a variable each.
 */
export const C = {
  bg: 'var(--c-bg)',
  sidebar: 'var(--c-sidebar)',
  footer: 'var(--c-footer)',
  panel: 'var(--c-panel)',
  panel2: 'var(--c-panel2)',
  input: 'var(--c-input)',
  border: 'rgba(var(--c-ink-rgb),0.07)',
  border2: 'rgba(var(--c-ink-rgb),0.1)',
  border3: 'rgba(var(--c-ink-rgb),0.13)',
  hair: 'rgba(var(--c-ink-rgb),0.05)',
  hover: 'rgba(var(--c-ink-rgb),0.08)',
  text: 'var(--c-text)',
  textHi: 'var(--c-text-hi)',
  textMax: 'var(--c-text-max)',
  /** Slightly above `text` — pane header titles and other quiet emphasis. */
  textStrong: 'var(--c-text-strong)',
  body: 'var(--c-body)',
  /** Label colour for secondary (Cancel) buttons. */
  textBtn: 'var(--c-text-btn)',
  /** Between `body` and `muted` — icon-button glyphs, meta lines. */
  textSubtle: 'var(--c-text-subtle)',
  muted: 'var(--c-muted)',
  dim: 'var(--c-dim)',
  faint: 'var(--c-faint)',
  faint2: 'var(--c-faint2)',
  accent: 'var(--c-accent)',
  accentSoft: 'var(--c-accent-soft)',
  accentText: 'var(--c-accent-text)',
  accentBg: 'rgba(var(--c-accent-rgb),0.1)',
  accentBgHi: 'rgba(var(--c-accent-rgb),0.16)',
  accentBorder: 'rgba(var(--c-accent-rgb),0.32)',
  kindIcon: 'var(--c-kind-icon)',
  danger: 'var(--c-danger)',
  /** Backdrop behind modals. */
  scrim: 'rgba(var(--c-shadow-rgb),0.66)',
  shadowModal: '0 24px 60px rgba(var(--c-shadow-rgb),0.6)',
  shadowMenu: '0 16px 40px rgba(var(--c-shadow-rgb),0.55)',
} as const

/** Hairline/hover tint mixed from the theme's text colour. */
export const ink = (a: number): string => `rgba(var(--c-ink-rgb),${a})`
/** Accent wash — selected rows, toggles, primary-button disabled states. */
export const accentA = (a: number): string => `rgba(var(--c-accent-rgb),${a})`
/** Error wash — destructive buttons and banners. */
export const dangerA = (a: number): string => `rgba(var(--c-danger-rgb),${a})`
/** Background wash — veils drawn over a pane's own background. */
export const bgA = (a: number): string => `rgba(var(--c-bg-rgb),${a})`

export const STATUS_COLORS: Record<SessionStatus, string> = {
  busy: 'var(--c-status-busy)',
  waiting: 'var(--c-status-waiting)',
  idle: 'var(--c-status-idle)',
  error: 'var(--c-status-error)',
  closed: 'var(--c-status-closed)',
}

export const STATUS_LABELS: Record<SessionStatus, string> = {
  busy: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  error: 'Error',
  closed: 'Closed',
}

export const FONT = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"

/**
 * Scales a pixel value by the user-controlled `--icon-scale` CSS variable so
 * icon-button boxes grow/shrink in lockstep with their icons. Falls back to 1
 * (no scaling) before the variable is set. See Settings → ICON SIZE.
 */
export const sz = (px: number): string => `calc(${px}px * var(--icon-scale, 1))`

/** Inline-style for a status dot, including the animation per status. */
export function dotStyle(status: SessionStatus, size = 9): React.CSSProperties {
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flex: 'none',
    background: STATUS_COLORS[status],
  }
  if (status === 'waiting') base.animation = 'cc-pulse 1.5s ease-in-out infinite'
  else if (status === 'busy') base.animation = 'cc-breathe 1.3s ease-in-out infinite'
  else if (status === 'closed') base.opacity = 0.55
  return base
}
