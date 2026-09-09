import { useRef, useState } from 'react'
import type { Session } from '../../shared/types'
import { useStore } from '../state/store'
import { C, accentA, bgA, dangerA } from '../theme'
import { Icon } from '../icons'
import * as registry from '../term/registry'
import { attachDrop } from '../attach'
import { PaneHeader } from './PaneHeader'
import { TerminalView } from './TerminalView'
import { EditorPaneBody } from './EditorPaneBody'
import { ConversationView } from './ConversationView'

/** True for a drag carrying files — a sidebar session drag carries text/plain. */
function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files')
}

/**
 * Makes a pane a drop target for files.
 *
 * What a drop means depends on the pane: a Claude session gets the paths in its
 * prompt (it reads them itself), a shell gets them shell-quoted at its prompt —
 * the same thing every other terminal does with a dropped file. Panes that can
 * take neither still light up and say so, rather than swallowing the drop.
 *
 * dragenter/dragleave fire for every child the pointer crosses (xterm nests
 * several), so the highlight is driven by a depth count, not a boolean.
 */
function useFileDrop(session: Session | undefined, index: number) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const focusPane = useStore((s) => s.focusPane)
  const pushToast = useStore((s) => s.pushToast)

  const clear = () => {
    depth.current = 0
    setOver(false)
  }

  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      setOver(true)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      // Both this and the drop must preventDefault, or Electron follows the file
      // and navigates the window away from the app.
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      depth.current -= 1
      if (depth.current <= 0) clear()
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      clear()
      focusPane(index)
      if (!session) {
        pushToast({
          tone: 'error',
          text: "Couldn't attach",
          sub: 'this pane has no session — open one first',
        })
        return
      }
      const { id: sid, kind } = session
      void attachDrop(sid, e.dataTransfer).then(() => {
        if (kind !== 'editor') registry.focus(sid)
      })
    },
  }

  return { over, dropProps }
}

/**
 * The "yes, this pane will take it" affordance during a drag. Pointer-events off:
 * a veil that could receive the drag would flip dragenter/dragleave endlessly.
 */
function DropVeil({ label, bad }: { label: string; bad?: boolean }): React.JSX.Element {
  const tint = bad ? dangerA : accentA
  return (
    <div
      style={{
        position: 'absolute',
        inset: 4,
        zIndex: 3,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        border: `2px dashed ${tint(0.55)}`,
        borderRadius: 10,
        background: bgA(0.66),
        color: bad ? C.danger : C.accentSoft,
        fontSize: 12.5,
        fontWeight: 600,
        animation: 'cc-fade 0.12s ease',
      }}
    >
      <Icon name="paperclip" size={16} />
      {label}
    </div>
  )
}

export function TerminalPane({ id, index }: { id: string; index: number }): React.JSX.Element {
  const session = useStore((s) => (id ? s.sessions[id] : undefined))
  const focused = useStore((s) => s.focused === index)
  const multi = useStore((s) => s.panes.length > 1)
  const focusPane = useStore((s) => s.focusPane)
  const setShowNew = useStore((s) => s.setShowNew)
  const showTranscript = useStore((s) => (id ? !!s.transcripts[id] : false))
  const { over, dropProps } = useFileDrop(session, index)

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
        ...frame,
      }}
    >
      {over && (
        <DropVeil
          label={
            session.kind === 'claude'
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
