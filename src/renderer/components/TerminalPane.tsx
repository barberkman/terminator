import { useStore } from '../state/store'
import { C, accentA, bgA } from '../theme'
import { Icon } from '../icons'
import * as registry from '../term/registry'
import { PaneHeader } from './PaneHeader'
import { TerminalView } from './TerminalView'
import { EditorPaneBody } from './EditorPaneBody'
import { ConversationView } from './ConversationView'
import { DropVeil, useFileDrop } from './paneDrop'

/**
 * Every pane but a browser one. `cell` is the grid placement PaneGrid works out:
 * explicit now that the grid's children are no longer one-per-cell in DOM order
 * (browser panes are permanent children of the same grid — see BrowserPane).
 */
export function TerminalPane({
  id,
  index,
  cell,
}: {
  id: string
  index: number
  cell?: React.CSSProperties
}): React.JSX.Element {
  const session = useStore((s) => (id ? s.sessions[id] : undefined))
  const focused = useStore((s) => s.focused === index)
  const multi = useStore((s) => s.panes.length > 1)
  const focusPane = useStore((s) => s.focusPane)
  const setShowNew = useStore((s) => s.setShowNew)
  const showTranscript = useStore((s) => (id ? !!s.transcripts[id] : false))
  const toComposer = showTranscript && session?.kind === 'claude'
  const { over, dropProps } = useFileDrop(session, index, toComposer)

  const frame: React.CSSProperties = multi
    ? {
        border: `1px solid ${focused ? accentA(0.4) : C.border}`,
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
        {...dropProps}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          minWidth: 0,
          minHeight: 0,
          color: C.dim,
          background: C.bg,
          ...cell,
          ...frame,
        }}
      >
        {over && <DropVeil bad label="No session in this pane" />}
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

  // There is no `kind === 'browser'` branch here, and adding one back would bring
  // the reload-on-every-click bug with it: a browser pane has to be mounted for
  // longer than a split, so PaneGrid renders those itself (see BrowserPane).

  // Editor sessions have no PTY: render the in-app file browser/editor and skip
  // both TerminalView (which would spawn a process) and the relaunch overlay.
  if (session.kind === 'editor') {
    return (
      <div
        data-pane-index={index}
        data-pane-focused={focused ? 1 : 0}
        data-pane-session={session.name}
        onMouseDownCapture={() => focusPane(index)}
        {...dropProps}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          background: C.bg,
          overflow: 'hidden',
          ...cell,
          ...frame,
        }}
      >
        {over && <DropVeil bad label="Editor panes can't take attachments" />}
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
      {...dropProps}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        background: C.bg,
        overflow: 'hidden',
        ...cell,
        ...frame,
      }}
    >
      {over && (
        <DropVeil
          label={
            toComposer
              ? 'Drop to attach to your message'
              : session.kind === 'claude'
                ? `Drop to attach to ${session.name}`
                : 'Drop to paste the path'
          }
        />
      )}
      <PaneHeader session={session} active={focused} />
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <TerminalView id={id} active={focused} />
        {needsRelaunch && !showTranscript && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: bgA(0.72),
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
        {/* Over the terminal, never instead of it: the xterm stays mounted and
            the right size underneath, so switching back costs nothing and a
            closed session's conversation is still readable. */}
        {session.kind === 'claude' && showTranscript && <ConversationView session={session} />}
      </div>
    </div>
  )
}
