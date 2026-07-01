import { useStore } from '../state/store'
import { C } from '../theme'
import { Icon } from '../icons'
import * as registry from '../term/registry'
import { PaneHeader } from './PaneHeader'
import { TerminalView } from './TerminalView'
import { EditorPaneBody } from './EditorPaneBody'

export function TerminalPane({ id, index }: { id: string; index: number }): React.JSX.Element {
  const session = useStore((s) => (id ? s.sessions[id] : undefined))
  const focused = useStore((s) => s.focused === index)
  const multi = useStore((s) => s.panes.length > 1)
  const focusPane = useStore((s) => s.focusPane)
  const setShowNew = useStore((s) => s.setShowNew)

  const frame: React.CSSProperties = multi
    ? {
        border: `1px solid ${focused ? 'rgba(217,119,87,0.4)' : C.border}`,
        borderRadius: 8,
      }
    : {}

  if (!id || !session) {
    return (
      <div
        data-pane-index={index}
        data-pane-focused={focused ? 1 : 0}
        data-pane-session=""
        onMouseDownCapture={() => focusPane(index)}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          minWidth: 0,
          minHeight: 0,
          color: C.dim,
          background: C.bg,
          ...frame,
        }}
      >
        <span style={{ opacity: 0.4 }}>
          <Icon name="bigplus" size={26} />
        </span>
        <div style={{ fontSize: 12 }}>Empty pane</div>
        <button
          onClick={() => setShowNew(true)}
          style={{
            padding: '7px 13px',
            background: C.accentBg,
            border: `1px solid ${C.accentBorder}`,
            borderRadius: 8,
            color: C.accentSoft,
            font: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          New session
        </button>
      </div>
    )
  }

  // Editor sessions have no PTY: render the in-app file browser/editor and skip
  // both TerminalView (which would spawn a process) and the relaunch overlay.
  if (session.kind === 'editor') {
    return (
      <div
        data-pane-index={index}
        data-pane-focused={focused ? 1 : 0}
        data-pane-session={session.name}
        onMouseDownCapture={() => focusPane(index)}
        style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          background: C.bg,
          overflow: 'hidden',
          ...frame,
        }}
      >
        <PaneHeader session={session} active={focused} />
        <EditorPaneBody session={session} />
      </div>
    )
  }

  // Restored or closed sessions come back "not running" — offer an explicit relaunch.
  const needsRelaunch = !session.alive && session.everStarted
  const relaunch = (e: React.MouseEvent) => {
    e.stopPropagation()
    const { cols, rows } = registry.refit(id)
    void window.terminator.startSession(id, cols, rows)
  }

  return (
    <div
      data-pane-index={index}
      data-pane-focused={focused ? 1 : 0}
      data-pane-session={session.name}
      onMouseDownCapture={() => focusPane(index)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        background: C.bg,
        overflow: 'hidden',
        ...frame,
      }}
    >
      <PaneHeader session={session} active={focused} />
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <TerminalView id={id} active={focused} />
        {needsRelaunch && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(26,25,23,0.72)',
            }}
          >
            <button
              onClick={relaunch}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '10px 18px',
                background: C.accentBg,
                border: `1px solid ${C.accentBorder}`,
                borderRadius: 9,
                color: C.accentSoft,
                font: 'inherit',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Icon name="power" size={15} />
              {session.kind === 'claude' ? 'Relaunch (resume conversation)' : 'Relaunch session'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
