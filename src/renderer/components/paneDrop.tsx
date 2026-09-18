import { useRef, useState } from 'react'
import type { Session } from '../../shared/types'
import { useStore } from '../state/store'
import { C, accentA, bgA, dangerA } from '../theme'
import { Icon } from '../icons'
import * as registry from '../term/registry'
import { attachDrop, attachDropToComposer } from '../attach'

// What every pane shares about being dropped on. Lifted out of TerminalPane when
// browser panes stopped being rendered by it: both pane components need this, and
// a browser pane importing it *from* the terminal pane would be a dependency that
// says nothing true about either.

/**
 * True for a drag carrying files.
 *
 * A sidebar session drag carries `application/x-terminator-session` instead, and
 * is handled by SplitDropOverlay rather than here — so this stays the one test
 * that decides whether a pane should take a drop at all.
 */
export function hasFiles(e: React.DragEvent): boolean {
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
 *
 * `toComposer` is on while the pane is showing its conversation: the drop then
 * belongs to the message being written, not to the terminal lying hidden
 * underneath. Typing the path into an input box the overlay covers was the old
 * behaviour, and it was never useful.
 */
export function useFileDrop(session: Session | undefined, index: number, toComposer: boolean) {
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
      if (toComposer) {
        // No registry.focus here, deliberately: the terminal is covered, and
        // pulling focus onto it would take the caret out of the composer the user
        // is typing in — and with it the Esc handler's only way home.
        void attachDropToComposer(sid, e.dataTransfer)
        return
      }
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
export function DropVeil({ label, bad }: { label: string; bad?: boolean }): React.JSX.Element {
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
