import { useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { computeFractions, type PaneFraction, type Side } from '../state/paneTree'
import { C, accentA, bgA } from '../theme'
import { Icon } from '../icons'

/**
 * The MIME type a sidebar session drag carries.
 *
 * `dataTransfer.getData` is deliberately unreadable during dragover — the page
 * mustn't learn what you're dragging until you commit to dropping it — but
 * `types` is readable throughout. So the type is what a drop target checks to
 * tell a session drag from a file drag; the id itself comes from the store,
 * which the drag start sets at the same moment.
 */
export const SESSION_MIME = 'application/x-terminator-session'

/** How close to an edge counts as "split here" rather than "open here". */
const EDGE = 0.25

export type DropZone = { index: number; side: Side | null }

/**
 * Which pane the pointer is in, and whether it's near an edge.
 *
 * Distances are normalised per axis before being compared, so a pane twice as
 * wide as it is tall doesn't end up with left/right bands twice as deep as its
 * top/bottom ones. Without that, corners resolve to whichever axis happens to be
 * longer instead of to the edge the pointer is actually nearest.
 */
export function zoneAt(fractions: PaneFraction[], x: number, y: number): DropZone | null {
  const index = fractions.findIndex(
    (f) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h,
  )
  if (index < 0) return null
  const f = fractions[index]
  if (f.w <= 0 || f.h <= 0) return { index, side: null }
  const rx = (x - f.x) / f.w
  const ry = (y - f.y) / f.h
  const dx = Math.min(rx, 1 - rx)
  const dy = Math.min(ry, 1 - ry)
  if (Math.min(dx, dy) > EDGE) return { index, side: null }
  if (dx <= dy) return { index, side: rx < 0.5 ? 'left' : 'right' }
  return { index, side: ry < 0.5 ? 'top' : 'bottom' }
}

/** The slice of a pane a drop would claim — the half toward `side`, or all of it. */
function preview(f: PaneFraction, side: Side | null): PaneFraction {
  if (!side) return f
  if (side === 'left') return { ...f, w: f.w / 2 }
  if (side === 'right') return { x: f.x + f.w / 2, y: f.y, w: f.w / 2, h: f.h }
  if (side === 'top') return { ...f, h: f.h / 2 }
  return { x: f.x, y: f.y + f.h / 2, w: f.w, h: f.h / 2 }
}

/**
 * Where a dragged session lands.
 *
 * One flat layer over the whole grid, mounted only while a sidebar drag is in
 * flight. It is not a per-pane drop handler, for two reasons that both come from
 * what panes are made of:
 *
 *   • An Electron <webview> swallows drag events, so a handler on a browser pane
 *     would never see a drag crossing it. A DOM overlay above it does — the guest
 *     is an ordinary element, so anything stacked over it keeps working
 *     (BrowserPaneBody says so at the top).
 *   • xterm nests several elements, so dragenter/dragleave fire repeatedly as the
 *     pointer crosses one pane; the file drop has to keep a depth counter to
 *     survive it. A single layer with no children never sees those events at all.
 *
 * File drags don't come here: this is only mounted while `draggingSessionId` is
 * set, so a file still reaches the pane underneath and attaches as it always has.
 */
export function SplitDropOverlay({
  sessionId,
  gap,
}: {
  sessionId: string
  gap: number
}): React.JSX.Element {
  const tree = useStore((s) => s.tree)
  const panes = useStore((s) => s.panes)
  const name = useStore((s) => s.sessions[sessionId]?.name)
  const openInPane = useStore((s) => s.openInPane)
  const splitPane = useStore((s) => s.splitPane)
  const setDraggingSession = useStore((s) => s.setDraggingSession)
  const [zone, setZone] = useState<DropZone | null>(null)

  const fractions = useMemo(() => computeFractions(tree), [tree])

  /** Would this drop change anything? Dropping a session on itself shouldn't. */
  const isNoop = (z: DropZone): boolean => panes[z.index] === sessionId

  const locate = (e: React.DragEvent): DropZone | null => {
    const r = e.currentTarget.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    return zoneAt(fractions, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
  }

  const carriesSession = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes(SESSION_MIME)

  // An empty pane can't be split — the store turns such a drop into a plain
  // open — so the preview must not promise a split either.
  const effective: DropZone | null = zone
    ? { index: zone.index, side: panes[zone.index] ? zone.side : null }
    : null
  // Half the gutter keeps the preview inside the pane's own frame. The floor is
  // for the single-pane case, where there is no gutter at all and the dashed
  // border would otherwise be drawn flush against the window edge and look
  // clipped.
  const inset = Math.max(gap / 2, 4)
  const box = effective ? preview(fractions[effective.index], effective.side) : null

  return (
    <div
      onDragOver={(e) => {
        if (!carriesSession(e)) return
        e.preventDefault()
        const z = locate(e)
        e.dataTransfer.dropEffect = z && !isNoop(z) ? 'move' : 'none'
        setZone((prev) =>
          prev?.index === z?.index && prev?.side === z?.side ? prev : z,
        )
      }}
      onDragLeave={() => setZone(null)}
      onDrop={(e) => {
        if (!carriesSession(e)) return
        e.preventDefault()
        e.stopPropagation()
        const z = locate(e)
        setZone(null)
        // Cleared here as well as on the row's dragend: the overlay must come
        // down on the same tick as the drop, or it briefly covers the layout it
        // just created.
        setDraggingSession(null)
        if (!z || isNoop(z)) return
        if (z.side) splitPane(sessionId, z.index, z.side)
        else openInPane(sessionId, z.index)
      }}
      // Named like the panes' own `data-pane-*` markers, for the same reason:
      // this layer only exists mid-drag, so there is otherwise nothing stable to
      // point at from outside.
      data-drop-overlay={zone ? `${zone.index}:${zone.side ?? 'centre'}` : ''}
      style={{ position: 'absolute', inset: 0, zIndex: 10 }}
    >
      {box && effective && (
        <div
          style={{
            position: 'absolute',
            left: `${box.x * 100}%`,
            top: `${box.y * 100}%`,
            width: `${box.w * 100}%`,
            height: `${box.h * 100}%`,
            // Inset by the gutter so the preview sits inside the pane's frame
            // rather than straddling the seam next to it.
            padding: inset,
            boxSizing: 'border-box',
            pointerEvents: 'none',
            transition: 'left 0.1s ease, top 0.1s ease, width 0.1s ease, height 0.1s ease',
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              boxSizing: 'border-box',
              border: `2px dashed ${accentA(isNoop(effective) ? 0.25 : 0.55)}`,
              borderRadius: 10,
              background: bgA(0.66),
              color: C.accentSoft,
              fontSize: 12.5,
              fontWeight: 600,
              opacity: isNoop(effective) ? 0.5 : 1,
              animation: 'cc-fade 0.12s ease',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              padding: '0 10px',
            }}
          >
            <Icon
              name={
                !effective.side
                  ? 'single'
                  : effective.side === 'left' || effective.side === 'right'
                    ? 'columns'
                    : 'rows'
              }
              size={16}
            />
            {isNoop(effective)
              ? 'Already here'
              : effective.side
                ? `Split — ${name ?? 'session'} here`
                : `Open ${name ?? 'session'} here`}
          </div>
        </div>
      )}
    </div>
  )
}
