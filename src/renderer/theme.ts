import type { SessionStatus } from '../shared/types'

/** Color tokens lifted from the imported design (Session Manager.dc.html). */
export const C = {
  bg: '#1a1917',
  sidebar: '#201e1b',
  footer: '#1d1c19',
  panel: '#211f1c',
  panel2: '#242220',
  input: '#191815',
  border: 'rgba(214,209,196,0.07)',
  border2: 'rgba(214,209,196,0.1)',
  border3: 'rgba(214,209,196,0.13)',
  hair: 'rgba(214,209,196,0.05)',
  hover: 'rgba(214,209,196,0.08)',
  text: '#cbc6b8',
  textHi: '#e8e4d9',
  textMax: '#f0ece2',
  body: '#a8a397',
  muted: '#807b6f',
  dim: '#6e6a60',
  faint: '#5e594f',
  faint2: '#4d4940',
  accent: '#d97757',
  accentSoft: '#e3ad96',
  accentText: '#1a120c',
  accentBg: 'rgba(217,119,87,0.1)',
  accentBgHi: 'rgba(217,119,87,0.16)',
  accentBorder: 'rgba(217,119,87,0.32)',
  kindIcon: '#7d8597',
  danger: '#e08070',
} as const

export const STATUS_COLORS: Record<SessionStatus, string> = {
  busy: '#7a9bbf',
  waiting: '#d97757',
  idle: '#80a86f',
  error: '#cf5e4e',
  closed: '#6e6a60',
}

export const STATUS_LABELS: Record<SessionStatus, string> = {
  busy: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  error: 'Error',
  closed: 'Closed',
}

export const FONT = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"

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
