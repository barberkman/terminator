import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { MIN_FRACTION, type Divider } from '../state/paneTree'
import { accentA } from '../theme'

/** Smallest a pane may be dragged to, in px — below this a terminal is unreadable. */
const MIN_PX = 120

const keyOf = (d: Divider): string => `${d.path.join('-')}:${d.index}`

/**
 * The draggable seams between panes.
 *
 * They are siblings of the panes rather than parts of them, sitting in the gutter
 * the layout already leaves — so the hit target is exactly the gap you can see,
 * and no pane has to know it has a neighbour.
 *
 * The gesture is the same shape as the editor's file-tree splitter
 * (EditorPaneBody): mousedown on the handle, then mousemove/mouseup bound to the
 * window so the pointer can outrun an 8px target. One thing is needed here that
 * isn't needed there — see the shield at the bottom.
 *
 * All the arithmetic the drag needs rides along on the divider itself
 * (`start`/`span`/`before`/`pair`, worked out in paneTree.ts), so this never has
 * to find its way back up the tree from a DOM element.
 */
export function PaneDividers({
  dividers,
  container,
}: {
  dividers: Divider[]
  container: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const resizeSplit = useStore((s) => s.resizeSplit)
  const resetSplit = useStore((s) => s.resetSplit)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  // The handlers below are bound once per gesture, so they read the divider from
  // here rather than closing over a value that a re-render would make stale.
  const live = useRef<Divider | null>(null)

  useEffect(() => {
    if (!activeKey) return

    const onMove = (e: MouseEvent) => {
      const d = live.current
      const box = container.current
      if (!d || !box) return
      const r = box.getBoundingClientRect()
      const row = d.dir === 'row'
      const total = row ? r.width : r.height
      if (total <= 0 || d.span <= 0) return

      // Pointer → fraction of the grid → fraction of the parent split, which is
      // the unit `sizes` is kept in.
      const inGrid = row ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height
      const inParent = (inGrid - d.start) / d.span
      // The seam sits at `before + sizes[index]`, so what's left of the pointer
      // beyond `before` is the first pane's new share.
      const want = inParent - d.before

      // MIN_PX is a share of the parent, not of the window — and never more than
      // half the pair, or a narrow split could not be moved at all.
      const min = Math.min(MIN_FRACTION, MIN_PX / (total * d.span), d.pair / 2)
      resizeSplit(d.path, d.index, want, min)
    }

    const onUp = () => {
      live.current = null
      setActiveKey(null)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [activeKey, container, resizeSplit])

  if (!dividers.length) return null

  const active = activeKey ? dividers.find((d) => keyOf(d) === activeKey) : undefined

  return (
    <>
      {dividers.map((d) => {
        const row = d.dir === 'row'
        const on = keyOf(d) === activeKey
        return (
          <div
            key={keyOf(d)}
            data-divider={keyOf(d)}
            onMouseDown={(e) => {
              if (e.button !== 0) return // a right-click on a seam belongs to nobody
              e.preventDefault()
              live.current = d
              setActiveKey(keyOf(d))
            }}
            onDoubleClick={() => resetSplit(d.path)}
            title="Drag to resize · double-click to even out"
            style={{
              position: 'absolute',
              left: d.left,
              top: d.top,
              width: d.width,
              height: d.height,
              zIndex: 4,
              cursor: row ? 'col-resize' : 'row-resize',
              // Invisible until grabbed. The gutter already reads as a
              // separation; a permanent line down every seam would turn a calm
              // layout into a grid of boxes.
              background: on ? accentA(0.5) : 'transparent',
              borderRadius: 2,
            }}
          />
        )
      })}
      {/* While dragging, a transparent sheet over everything. Without it the
          pointer crosses a <webview>, the guest swallows the mousemove and the
          drag dies halfway across the window — the same reason dragging over an
          <iframe> needs one. It also holds the resize cursor steady over panes
          that would otherwise set their own. */}
      {active && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            cursor: active.dir === 'row' ? 'col-resize' : 'row-resize',
          }}
        />
      )}
    </>
  )
}
