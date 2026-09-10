import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { C, FONT, dangerA } from '../theme'
import { Icon, type IconName } from '../icons'

/**
 * One line of a context menu.
 *
 * There is deliberately no `disabled` variant. A menu that doesn't apply to what
 * you right-clicked should be shorter, not the same length with half of it greyed
 * out — leaving the field out of the type makes the greyed-out version
 * unrepresentable rather than merely discouraged. A section that has nothing to
 * offer returns [].
 */
export type MenuNode =
  | { kind: 'sep' }
  | { kind: 'heading'; label: string; sub?: string }
  | {
      kind: 'item'
      id: string
      label: string
      icon?: IconName
      /** Right-aligned dim text: a folder name, a caveat, what's in a split. */
      note?: string
      danger?: boolean
      checked?: boolean
      run: () => void
    }
  | { kind: 'sub'; id: string; label: string; icon?: IconName; note?: string; items: MenuNode[] }

/** Where a panel puts itself: at the pointer, or beside the item that opened it. */
export type Placement =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'flyout'; anchor: DOMRect }

/** Gap kept between the panel and the window edge, matching term/links.ts. */
const EDGE = 6
/** Above Toasts (40) and every modal; a peer of the terminal link menu (80). */
const Z = 78

const isFocusable = (n: MenuNode): boolean => n.kind === 'item' || n.kind === 'sub'

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  zIndex: Z,
  minWidth: 216,
  maxWidth: 340,
  maxHeight: 'calc(100vh - 12px)',
  overflowY: 'auto',
  padding: 4,
  background: C.panel,
  border: `1px solid ${C.border3}`,
  borderRadius: 9,
  boxShadow: C.shadowMenu,
  fontFamily: FONT,
  outline: 'none',
  animation: 'cc-fade 0.12s ease',
}

export function MenuPanel({
  nodes,
  place,
  isRoot,
  onClose,
  onCloseAll,
}: {
  nodes: MenuNode[]
  place: Placement
  isRoot?: boolean
  /** Close this panel only — a flyout hands focus back to its parent. */
  onClose: () => void
  /** Dismiss the whole menu. Always called before an item's run(). */
  onCloseAll: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(() => nodes.findIndex(isFocusable))
  const [openSub, setOpenSub] = useState<string | null>(null)
  const typed = useRef({ buf: '', at: 0 })
  const hoverTimer = useRef<number | null>(null)

  const focusSelf = useCallback(() => ref.current?.focus({ preventScroll: true }), [])
  useEffect(focusSelf, [focusSelf])

  // Position before paint, so the panel never shows up in the wrong place first.
  // A flyout gets its parent item's rect rather than a point, because only the
  // child knows its own width and therefore whether it has to flip to the left.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left: number
    let top: number
    if (place.kind === 'point') {
      left = place.x + 2
      top = place.y + 2
    } else {
      left = place.anchor.right - 4
      if (left + w > window.innerWidth - EDGE) left = place.anchor.left - w + 4
      top = place.anchor.top - 5
    }
    el.style.left = `${Math.max(EDGE, Math.min(left, window.innerWidth - w - EDGE))}px`
    el.style.top = `${Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE))}px`
  }, [place, nodes])

  const step = (from: number, dir: 1 | -1): number => {
    const n = nodes.length
    for (let i = 1; i <= n; i++) {
      const j = (((from + dir * i) % n) + n) % n
      if (isFocusable(nodes[j])) return j
    }
    return from
  }

  const openSubmenu = (i: number) => {
    const n = nodes[i]
    if (n?.kind !== 'sub') return
    setActive(i)
    setOpenSub(n.id)
  }

  const activate = (i: number) => {
    const n = nodes[i]
    if (!n) return
    if (n.kind === 'sub') return openSubmenu(i)
    if (n.kind !== 'item') return
    // Dismiss before running, like term/links.ts does: an action that opens a
    // rename input or a dialog must not have the menu still sitting over it.
    onCloseAll()
    n.run()
  }

  // Only the panel is focused (items get styling, not focus), so one handler owns
  // every key and Escape is unambiguously ours. Capture phase on `document` puts
  // it ahead of App.tsx's bubble-phase Escape chain; stopPropagation keeps a
  // bare Escape from also reaching whatever is underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (openSub) return // the open flyout owns the keyboard
      const take = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      switch (e.key) {
        case 'ArrowDown':
          take()
          return setActive((i) => step(i, 1))
        case 'ArrowUp':
          take()
          return setActive((i) => step(i, -1))
        case 'Home':
          take()
          return setActive(nodes.findIndex(isFocusable))
        case 'End':
          take()
          return setActive(step(nodes.findIndex(isFocusable), -1))
        case 'ArrowRight':
          if (nodes[active]?.kind === 'sub') {
            take()
            openSubmenu(active)
          }
          return
        case 'ArrowLeft':
          if (!isRoot) {
            take()
            onClose()
          }
          return
        case 'Enter':
        case ' ':
          take()
          return activate(active)
        case 'Escape':
          take()
          return isRoot ? onCloseAll() : onClose()
      }
      // Typeahead: jump to the next item whose label starts with what you typed.
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return
      const now = Date.now()
      const t = typed.current
      t.buf = now - t.at > 600 ? e.key : t.buf + e.key
      t.at = now
      const q = t.buf.toLowerCase()
      for (let i = 1; i <= nodes.length; i++) {
        const j = (active + i) % nodes.length
        const n = nodes[j]
        if (isFocusable(n) && 'label' in n && n.label.toLowerCase().startsWith(q)) {
          take()
          setActive(j)
          return
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [nodes, active, openSub, isRoot, onClose, onCloseAll])

  // A fixed-position menu must not float free of the row it belongs to.
  useEffect(() => {
    if (!isRoot) return
    const bye = () => onCloseAll()
    window.addEventListener('resize', bye)
    document.addEventListener('scroll', bye, true)
    return () => {
      window.removeEventListener('resize', bye)
      document.removeEventListener('scroll', bye, true)
    }
  }, [isRoot, onCloseAll])

  // Outside-press dismissal. A capture listener rather than a full-screen scrim,
  // because a scrim would swallow the right-click that should re-target the menu
  // onto another row. Flyouts are nested inside the root's DOM, so one contains()
  // covers them. Attached next tick so the press that opened it can't close it —
  // the same guard term/links.ts uses.
  useEffect(() => {
    if (!isRoot) return
    const swallowClick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      document.removeEventListener('click', swallowClick, true)
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      onCloseAll()
      // A left-click outside should only dismiss, matching the app's other
      // popovers; a right-click falls through so the row under it can open its own.
      if (e.button !== 2) {
        e.preventDefault()
        e.stopPropagation()
        document.addEventListener('click', swallowClick, true)
      }
    }
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown, true)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('click', swallowClick, true)
    }
  }, [isRoot, onCloseAll])

  useEffect(
    () => () => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    },
    [],
  )

  const hoverItem = (i: number, node: MenuNode) => {
    setActive(i)
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    if (node.kind === 'sub') {
      hoverTimer.current = window.setTimeout(() => setOpenSub(node.id), 100)
    } else if (openSub) {
      setOpenSub(null)
    }
  }

  return (
    <div ref={ref} tabIndex={-1} style={panelStyle}>
      {nodes.map((n, i) => {
        if (n.kind === 'sep') {
          return (
            <div
              key={`sep${i}`}
              style={{ height: 1, margin: '4px 6px', background: C.hair }}
            />
          )
        }
        if (n.kind === 'heading') {
          return (
            <div key={`h${i}`} style={{ padding: '6px 11px 7px' }}>
              <div
                style={{
                  fontSize: 10.5,
                  color: C.textSubtle,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {n.label}
              </div>
              {!!n.sub && (
                <div
                  style={{
                    fontSize: 10,
                    color: C.dim,
                    marginTop: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {n.sub}
                </div>
              )}
            </div>
          )
        }

        const on = active === i
        const danger = n.kind === 'item' && n.danger
        return (
          <div key={n.id} style={{ position: 'relative' }}>
            <button
              type="button"
              ref={openSub === n.id ? (subRef as React.Ref<HTMLButtonElement>) : undefined}
              onMouseEnter={() => hoverItem(i, n)}
              onClick={() => activate(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '7px 11px',
                border: 'none',
                borderRadius: 6,
                background: on ? (danger ? dangerA(0.14) : C.hover) : 'transparent',
                color: danger ? C.danger : on ? C.textHi : C.body,
                font: 'inherit',
                fontSize: 12,
                textAlign: 'left',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {!!n.icon && (
                <span
                  style={{
                    display: 'flex',
                    flex: 'none',
                    color: danger ? C.danger : on ? C.accent : C.muted,
                  }}
                >
                  <Icon name={n.icon} size={14} />
                </span>
              )}
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {n.label}
              </span>
              {!!n.note && (
                <span style={{ color: C.dim, fontSize: 10.5, flex: 'none' }}>{n.note}</span>
              )}
              {n.kind === 'item' && n.checked && (
                <span style={{ display: 'flex', flex: 'none', color: C.accent }}>
                  <Icon name="check" size={13} />
                </span>
              )}
              {n.kind === 'sub' && (
                <span
                  style={{
                    display: 'flex',
                    flex: 'none',
                    color: C.muted,
                    transform: 'rotate(-90deg)',
                  }}
                >
                  <Icon name="chevron" size={12} />
                </span>
              )}
            </button>
            {/* Nested in the DOM, not a sibling: a fixed child isn't clipped by an
                ancestor's overflow, and the root's outside-click test stays one
                contains() call. */}
            {n.kind === 'sub' && openSub === n.id && (
              <Flyout
                nodes={n.items}
                onClose={() => {
                  setOpenSub(null)
                  focusSelf()
                }}
                onCloseAll={onCloseAll}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** A submenu, measured against the item that opened it. */
function Flyout({
  nodes,
  onClose,
  onCloseAll,
}: {
  nodes: MenuNode[]
  onClose: () => void
  onCloseAll: () => void
}): React.JSX.Element | null {
  const holder = useRef<HTMLSpanElement>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)

  useLayoutEffect(() => {
    const btn = holder.current?.parentElement?.querySelector('button')
    if (btn) setAnchor(btn.getBoundingClientRect())
  }, [])

  return (
    <span ref={holder}>
      {anchor && (
        <MenuPanel
          nodes={nodes}
          place={{ kind: 'flyout', anchor }}
          onClose={onClose}
          onCloseAll={onCloseAll}
        />
      )}
    </span>
  )
}
