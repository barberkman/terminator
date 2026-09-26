import type { SessionRuntime } from '../../shared/types'
import { C } from '../theme'

/**
 * A small "WSL" tag for anything that runs inside a WSL distro — a session row, a
 * project header, a pane header. Nothing at all for Windows, which is what every
 * session was before WSL existed here, and so needs no label. The distro is in the
 * tooltip rather than the tag: there is usually one, and the tag has to fit in a row.
 */
export function RuntimeChip({ runtime }: { runtime?: SessionRuntime }): React.JSX.Element | null {
  if (runtime?.kind !== 'wsl') return null
  return (
    <span
      title={`Runs in WSL · ${runtime.distro}`}
      style={{
        flex: 'none',
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: 0.4,
        lineHeight: '13px',
        padding: '0 4px',
        borderRadius: 3,
        border: `1px solid ${C.border2}`,
        color: C.muted,
      }}
    >
      WSL
    </span>
  )
}
