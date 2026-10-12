import type { CreateSessionInput } from '../shared/types'
import { C } from './theme'
import type { IconName } from './icons'

/**
 * The kinds of session you can create, as one list shared by the New Session
 * dialog and the sidebar's "New session here" menu — so the two can never drift
 * apart on wording, icon or what they actually create. `kind` and `mode` are
 * separate on a Session (there is no read-only *kind*), which is why this extra
 * key exists at all.
 */
export type TypeKey = 'claude' | 'claude-ro' | 'shell' | 'editor' | 'browser' | 'pdf'

export const TYPES: {
  key: TypeKey
  icon: IconName
  color: string
  label: string
  desc: string
}[] = [
  { key: 'claude', icon: 'sparkle', color: C.accent, label: 'Claude', desc: 'Normal Claude Code session' },
  { key: 'claude-ro', icon: 'lock', color: C.muted, label: 'Claude · read-only', desc: 'Runs the read-only command' },
  { key: 'shell', icon: 'terminal', color: C.kindIcon, label: 'Terminal', desc: 'Plain shell — no Claude features' },
  { key: 'editor', icon: 'editor', color: C.kindIcon, label: 'Editor', desc: 'Browse and edit files — no Claude, no shell' },
  { key: 'browser', icon: 'globe', color: C.kindIcon, label: 'Browser', desc: 'A web page, in the app — keeps its own sign-ins' },
  { key: 'pdf', icon: 'pdf', color: C.kindIcon, label: 'PDF', desc: "A PDF from the project, read in the app's theme" },
]

export const TYPE_MAP: Record<TypeKey, Pick<CreateSessionInput, 'kind' | 'mode'>> = {
  claude: { kind: 'claude', mode: 'normal' },
  'claude-ro': { kind: 'claude', mode: 'readonly' },
  shell: { kind: 'shell', mode: 'normal' },
  editor: { kind: 'editor', mode: 'normal' },
  browser: { kind: 'browser', mode: 'normal' },
  pdf: { kind: 'pdf', mode: 'normal' },
}
