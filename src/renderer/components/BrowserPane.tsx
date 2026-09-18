import { useStore } from '../state/store'
import { C, accentA } from '../theme'
import { PaneHeader } from './PaneHeader'
import { BrowserPaneBody } from './BrowserPaneBody'
import { DropVeil, useFileDrop } from './paneDrop'

/**
 * A browser session's pane — the one pane kind that outlives the split it is in.
 *
 * Every other pane is rendered by TerminalPane, mounted when its session lands in
 * a split and unmounted when something else takes that split. A browser pane can't
 * work that way, because unmounting it destroys the <webview>, and a destroyed
 * guest is a page load: click away and back and you're staring at a spinner and a
 * scroll position you no longer have.
 *
 * Nor can it be moved. The terminal registry parks a hidden xterm by re-parenting
 * its host element (term/registry.ts), and that trick is unavailable here: an
 * Electron <webview> disconnected from the document runs its disconnectedCallback,
 * which throws the guest away — and the DOM removes-then-inserts even for a move
 * within the same parent, so "just reorder it" destroys it too. It is the same
 * reason moving an <iframe> reloads it.
 *
 * So PaneGrid renders one of these per live browser session, as a permanent child
 * of the grid, and this component only ever changes its *CSS*: into the rect of
 * the split showing it, or offscreen when no split is. The element never moves,
 * so the page never reloads — which is also why the whole layout is absolute
 * rects rather than nested boxes (see paneTree.ts).
 *
 * `index` is the split it currently occupies, or -1 for parked.
 */
export function BrowserPane({
  id,
  index,
  cell,
}: {
  id: string
  index: number
  cell?: React.CSSProperties
}): React.JSX.Element | null {
  // Subscribed here rather than handed down, so the grid doesn't have to watch the
  // whole session map to render these.
  const session = useStore((s) => s.sessions[id])
  const parked = index < 0
  const focused = useStore((s) => s.focused === index)
  const multi = useStore((s) => s.panes.length > 1)
  const focusPane = useStore((s) => s.focusPane)
  const { over, dropProps } = useFileDrop(session, index, false)

  // The store drops a removed session from `browserLive` in the same update that
  // drops it from `sessions`, so this is unreachable — but it is the difference
  // between a missing session being nothing and being a crash.
  if (!session) return null

  const frame: React.CSSProperties = multi
    ? {
        border: `1px solid ${focused ? accentA(0.4) : C.border}`,
        borderRadius: 8,
      }
    : {}

  // Offscreen rather than `display: none`, and with a real size rather than none:
  // Electron documents display:none as unreliable on a <webview>, and a guest
  // collapsed to zero would reflow the page down to nothing and back every time
  // you looked away. Same holder trick term/registry.ts uses for parked xterms —
  // 100% of the grid, which in the single layout is exactly the size it returns to,
  // so the common case reflows not at all.
  const place: React.CSSProperties = parked
    ? {
        position: 'absolute',
        left: -100000,
        top: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }
    : { ...cell, ...frame }

  return (
    <div
      // A parked pane is not a split, so it doesn't claim to be one. The pointer
      // can't reach it either — it is offscreen and pointer-events: none — which is
      // what keeps the drop handlers below honest without a second condition.
      data-pane-index={parked ? undefined : index}
      data-pane-focused={parked ? undefined : focused ? 1 : 0}
      data-pane-session={parked ? undefined : session.name}
      onMouseDownCapture={parked ? undefined : () => focusPane(index)}
      {...dropProps}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        background: C.bg,
        overflow: 'hidden',
        ...place,
      }}
    >
      {over && <DropVeil bad label="Browser panes can't take attachments" />}
      <PaneHeader session={session} active={!parked && focused} index={index} />
      <BrowserPaneBody session={session} shown={!parked} />
    </div>
  )
}
