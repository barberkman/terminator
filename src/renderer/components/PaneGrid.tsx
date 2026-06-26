import { useStore } from '../state/store'
import { C } from '../theme'
import { Icon } from '../icons'
import { TerminalPane } from './TerminalPane'

function EmptyState(): React.JSX.Element {
  const setShowNew = useStore((s) => s.setShowNew)
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        color: C.dim,
      }}
    >
      <span style={{ opacity: 0.5 }}>
        <Icon name="bigplus" size={30} />
      </span>
      <div style={{ fontSize: 13 }}>No session open</div>
      <button
        onClick={() => setShowNew(true)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 16px',
          background: 'rgba(217,119,87,0.12)',
          border: `1px solid ${C.accentBorder}`,
          borderRadius: 8,
          color: C.accentSoft,
          font: 'inherit',
          fontSize: 12.5,
          cursor: 'pointer',
        }}
      >
        Start a new session
      </button>
    </div>
  )
}

export function PaneGrid(): React.JSX.Element {
  const layout = useStore((s) => s.layout)
  const panes = useStore((s) => s.panes)

  if (!panes.some(Boolean)) return <EmptyState />

  const cols = layout === 'single' ? 1 : 2
  const single = layout === 'single'

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: layout === 'grid4' ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
        gap: single ? 0 : 8,
        padding: single ? 0 : 8,
      }}
    >
      {panes.map((id, i) => (
        <TerminalPane key={i} id={id} index={i} />
      ))}
    </div>
  )
}
