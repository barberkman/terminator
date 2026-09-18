import { useMemo, useRef } from 'react'
import { useStore } from '../state/store'
import { computeLayout } from '../state/paneTree'
import { C, accentA } from '../theme'
import { Icon } from '../icons'
import { TerminalPane } from './TerminalPane'
import { BrowserPane } from './BrowserPane'
import { PaneDividers } from './PaneDividers'
import { SplitDropOverlay } from './SplitDropOverlay'

/** The gutter between panes, and the padding around them, once there are two. */
const GAP = 8

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
 * Three things here are load-bearing rather than incidental. The first two are
 * for the same reason: a browser pane's <webview> dies if its element is ever
 * disconnected from the document, and "disconnected" includes being moved (see
 * BrowserPane).
 *
 *   • This grid element is never swapped out — not even for the empty state, which
 *     is an overlay on it rather than the early return it used to be. It is the
 *     parent every parked webview hangs from, so losing it would reload every page
 *     the moment you closed your last pane. Anything that later wraps this in a
 *     condition, or gives it a changing `key`, puts the bug back.
 *   • Children are placed by absolute CSS rects worked out from the split tree,
 *     never by nesting. A tree of nested <div>s is the obvious way to build
 *     resizable splits and it is the one thing that cannot be done here: every
 *     split would re-parent every browser pane. The tree decides geometry and
 *     nothing else — see state/paneTree.ts.
 *   • Terminal panes stay keyed by index. The children are laid out as
 *     [...terminal panes, ...browser panes]; keeping the terminal run in strict
 *     index order means React only ever adds or removes at the end of it, so a
 *     browser pane's element is never moved. Keying them by session id would let
 *     their relative order change, and React moves a keyed child's DOM node when
 *     it does — which is the reload bug again, by a different route.
 *
 * A pane spliced into the middle therefore hands a different `id` to whichever
 * TerminalPane already sits at that index. That is fine: TerminalView's effect is
 * keyed on the id, so it parks the old terminal and attaches the new one, and
 * React runs every cleanup before any effect — so the two never fight over an
 * element and no scrollback is lost.
 */
export function PaneGrid(): React.JSX.Element {
  const tree = useStore((s) => s.tree)
  const panes = useStore((s) => s.panes)
  const browserLive = useStore((s) => s.browserLive)
  const dragging = useStore((s) => s.draggingSessionId)
  const boxRef = useRef<HTMLDivElement>(null)

  const multi = panes.length > 1
  // Recomputed only when the shape changes, because it is also what the drop
  // overlay hit-tests against and what the dividers are drawn from.
  const { rects, dividers } = useMemo(() => computeLayout(tree, multi ? GAP : 0), [tree, multi])

  const cell = (i: number): React.CSSProperties => {
    const r = rects[i]
    // A pane with no rect can only mean the tree and `panes` disagree, which the
    // store's invariant forbids. Park it rather than drawing it at full size on
    // top of everything else.
    if (!r) return { position: 'absolute', left: -100000, top: 0, width: '100%', height: '100%' }
    return { position: 'absolute', left: r.left, top: r.top, width: r.width, height: r.height }
  }

  return (
    <div ref={boxRef} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
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

      {multi && <PaneDividers dividers={dividers} container={boxRef} />}

      {/* Only while a session is actually being dragged. Mounted above the panes
          because a <webview> swallows drag events, so a browser pane could never
          notice a drag crossing it — and because one flat layer has no nested
          children to fire spurious dragleave events, which is the bug the file
          drop has to keep a depth counter for. */}
      {dragging && <SplitDropOverlay sessionId={dragging} gap={multi ? GAP : 0} />}

      {!panes.some(Boolean) && <EmptyState />}
    </div>
  )
}
