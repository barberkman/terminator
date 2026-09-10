import { useEffect, useMemo, useRef } from 'react'
import { buildMenu } from '../menus'
import { useStore } from '../state/store'
import { MenuPanel } from './ContextMenu'

/**
 * The sidebar's context menu. Mounted once from App, not from Sidebar, for two
 * reasons: the sidebar's session list is an `overflowY: auto` scroller that would
 * clip a menu rendered inside it, and the app renders every overlay as a fixed
 * sibling at the top level rather than through a portal.
 */
export function SessionContextMenu(): React.JSX.Element | null {
  const menu = useStore((s) => s.contextMenu)
  const close = useStore((s) => s.closeContextMenu)
  const sessions = useStore((s) => s.sessions)
  const order = useStore((s) => s.order)
  const panes = useStore((s) => s.panes)
  const layout = useStore((s) => s.layout)
  const settings = useStore((s) => s.settings)
  const collapsed = useStore((s) => s.collapsed)
  const restore = useRef<Element | null>(null)

  const target = menu?.target
  const targetIds = target?.kind === 'sessions' ? target.ids : null

  // Right-clicking the sidebar takes focus off whatever had it — usually a
  // terminal. Put it back, unless something the menu opened (a rename input, a
  // modal) has already claimed it.
  useEffect(() => {
    if (!menu) return
    restore.current = document.activeElement
    return () => {
      const prev = restore.current
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return
        if (prev instanceof HTMLElement && document.contains(prev)) {
          prev.focus({ preventScroll: true })
        }
      })
    }
  }, [menu])

  // A session can go away underneath an open menu (it exits, or another surface
  // removes it). Resolving on every render means the rows re-derive — Stop turns
  // into Start when a process ends — and an emptied target closes the menu.
  const resolved = useMemo(
    () => (targetIds ? targetIds.map((id) => sessions[id]).filter(Boolean) : []),
    [targetIds, sessions],
  )

  useEffect(() => {
    if (targetIds && resolved.length === 0) close()
  }, [targetIds, resolved.length, close])

  // buildMenu returns a fresh array, so it must not live in a zustand selector —
  // the same trap buildGroups documents in state/store.ts.
  const nodes = useMemo(() => {
    if (!target) return []
    const project =
      target.kind === 'project'
        ? { name: target.name, path: target.path }
        : resolved[0]
          ? { name: resolved[0].projectName, path: resolved[0].projectPath }
          : null
    const projectSessions = project
      ? order.map((id) => sessions[id]).filter((s) => s && s.projectPath === project.path)
      : []
    return buildMenu({
      target,
      sessions: resolved,
      project,
      projectSessions,
      layout,
      panes,
      settings,
      collapsed,
    })
  }, [target, resolved, order, sessions, layout, panes, settings, collapsed])

  if (!menu || !nodes.length) return null

  // Keyed so right-clicking a different row remounts the panel rather than
  // reusing it — otherwise the keyboard highlight would carry over at a stale index.
  const key =
    menu.target.kind === 'project'
      ? `p:${menu.target.path}`
      : `s:${menu.target.ids.join(',')}:${menu.x},${menu.y}`
  return (
    <MenuPanel
      key={key}
      nodes={nodes}
      place={{ kind: 'point', x: menu.x, y: menu.y }}
      isRoot
      onClose={close}
      onCloseAll={close}
    />
  )
}
