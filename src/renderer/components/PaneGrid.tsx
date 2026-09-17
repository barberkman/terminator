import { useStore } from '../state/store'
import { C, accentA } from '../theme'
import { Icon } from '../icons'
import { TerminalPane } from './TerminalPane'
import { BrowserPane } from './BrowserPane'

/**
 * An overlay now, not a replacement for the grid — the grid element has to outlive
 * every session, because parked <webview>s hang from it (see below).
 */
function EmptyState(): React.JSX.Element {
  const setShowNew = useStore((s) => s.setShowNew)
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 5,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        color: C.dim,
        background: C.bg,
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
          background: accentA(0.12),
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

/**
 * The splits.
 *
 * Two things here are load-bearing rather than incidental, both for the same
 * reason: a browser pane's <webview> dies if its element is ever disconnected from
 * the document, and "disconnected" includes being moved (see BrowserPane).
 *
 *   • This grid element is never swapped out — not even for the empty state, which
 *     is an overlay on it rather than the early return it used to be. It is the
 *     parent every parked webview hangs from, so losing it would reload every page
 *     the moment you closed your last pane. Anything that later wraps this in a
 *     condition, or gives it a changing `key`, puts the bug back.
 *   • Children are placed into cells explicitly. They are no longer one-per-cell in
 *     DOM order — browser panes are permanent children, present whether or not a
 *     split is showing them — so grid auto-placement would put everything in the
 *     wrong box.
 *
 * The two child lists are kept separate, terminal panes first, so that splits
 * appearing and disappearing can never reorder a browser pane's element.
 */
export function PaneGrid(): React.JSX.Element {
  const layout = useStore((s) => s.layout)
  const panes = useStore((s) => s.panes)
  const browserLive = useStore((s) => s.browserLive)

  const cols = layout === 'single' ? 1 : 2
  const single = layout === 'single'

  const cell = (i: number): React.CSSProperties => ({
    gridColumn: (i % cols) + 1,
    gridRow: Math.floor(i / cols) + 1,
  })

  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: layout === 'grid4' ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
        gap: single ? 0 : 8,
        padding: single ? 0 : 8,
      }}
    >
      {panes.map((id, i) =>
        // A browser session's split is drawn by its own permanent pane below, so
        // this one would only cover it. Asked of `browserLive` rather than of the
        // session's kind because that is the list the layer below actually renders
        // from — the two can't disagree and leave a hole.
        browserLive.includes(id) ? null : <TerminalPane key={i} id={id} index={i} cell={cell(i)} />,
      )}

      {/* Never reordered — see `browserLive` in the store. A React-driven move of
          one of these elements is a page reload, which is the whole bug. */}
      {browserLive.map((id) => {
        const at = panes.indexOf(id)
        return <BrowserPane key={id} id={id} index={at} cell={at >= 0 ? cell(at) : undefined} />
      })}

      {!panes.some(Boolean) && <EmptyState />}
    </div>
  )
}
