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
  // into Start when a process ends — and an emptied target, a session list or a
  // project group alike, closes the menu.
  const resolved = useMemo(
    () => (targetIds ? targetIds.map((id) => sessions[id]).filter(Boolean) : []),
    [targetIds, sessions],
  )

  /**
   * The group behind a project target, by projectName — because that is how the
   * sidebar draws groups (buildGroups) and the header you right-clicked is one.
   * `projectSessions` below is path-scoped on purpose: Build/Run and the folder
   * actions run *in a folder*. The two lists disagree about a session started in
   * a worktree of the project, which keeps the group's name and carries the
   * worktree as its path — and a group-wide action has to mean the rows you see.
   */
  const groupName = target?.kind === 'project' ? target.name : null
  const groupSessions = useMemo(
    () =>
      groupName === null
        ? []
        : order.map((id) => sessions[id]).filter((s) => s && s.projectName === groupName),
    [groupName, order, sessions],
  )

  useEffect(() => {
    if (targetIds && resolved.length === 0) close()
    if (groupName !== null && groupSessions.length === 0) close()
  }, [targetIds, resolved.length, groupName, groupSessions.length, close])

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
      groupSessions,
      panes,
      settings,
      collapsed,
    })
  }, [target, resolved, groupSessions, order, sessions, panes, settings, collapsed])

  if (!menu || !nodes.length) return null

  // Keyed so right-clicking a different row remounts the panel rather than
  // reusing it — otherwise the keyboard highlight would carry over at a stale index.
  const t = menu.target
  const key =
    t.kind === 'project'
      ? `p:${t.path}`
      : t.kind === 'app'
        ? `a:${menu.x},${menu.y}`
        : `s:${t.ids.join(',')}:${menu.x},${menu.y}`
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
