import { create } from 'zustand'
import type { Session, Settings } from '../../shared/types'
import * as editor from '../editor/registry'

export type LayoutName = 'single' | 'cols2' | 'grid4'
export const LAYOUT_COUNT: Record<LayoutName, number> = { single: 1, cols2: 2, grid4: 4 }

export interface ConfirmState {
  kind: 'close' | 'remove' | 'worktree'
  id: string
  name: string
  /** For a worktree prompt reached via close/remove: also remove the session after. */
  removeAfter?: boolean
}

export interface ProjectGroup {
  name: string
  sessions: Session[]
  /** Nesting depth per session id — a branch sits one level under its parent. */
  depth: Record<string, number>
}

/** One sidebar line: a session plus what the branch tree adds around it. */
export interface SidebarRow {
  session: Session
  depth: number
  /** How many branches hang directly off this session. */
  branches: number
  /** True when this session's branches are collapsed out of view. */
  collapsed: boolean
  /** True when a branch hidden under this collapsed session needs attention. */
  hiddenNotified: boolean
}

interface StoreState {
  sessions: Record<string, Session>
  order: string[]
  layout: LayoutName
  panes: string[]
  focused: number
  collapsed: Record<string, boolean>
  showNew: boolean
  showSettings: boolean
  showNotes: boolean
  /** Session whose conversation the branch picker is open for. */
  branchFor: string | null
  sidebarHidden: boolean
  editingId: string | null
  confirm: ConfirmState | null
  settings: Settings | null

  init(): Promise<void>
  upsert(s: Session): void
  remove(id: string): void
  setLayout(name: LayoutName): void
  openSession(id: string): void
  reorderWithinGroup(draggedId: string, targetId: string): void
  focusPane(i: number): void
  toggleGroup(name: string): void
  startEdit(id: string | null): void
  setShowNew(v: boolean): void
  setShowSettings(v: boolean): void
  setShowNotes(v: boolean): void
  setBranchFor(id: string | null): void
  toggleSidebar(): void
  setConfirm(c: ConfirmState | null): void
  setSettings(s: Settings): void
}

function emptyPanes(count: number): string[] {
  return Array.from({ length: count }, () => '')
}

let initialized = false

export const useStore = create<StoreState>((set, get) => ({
  sessions: {},
  order: [],
  layout: 'single',
  panes: [''],
  focused: 0,
  collapsed: {},
  showNew: false,
  showSettings: false,
  showNotes: false,
  branchFor: null,
  sidebarHidden: false,
  editingId: null,
  confirm: null,
  settings: null,

  async init() {
    if (initialized) return
    initialized = true
    const [list, settings] = await Promise.all([
      window.terminator.listSessions(),
      window.terminator.getSettings(),
    ])
    const sessions: Record<string, Session> = {}
    const order: string[] = []
    for (const s of list) {
      sessions[s.id] = s
      order.push(s.id)
    }
    const panes = order.length ? [order[0]] : ['']
    set({ sessions, order, settings, panes })

    window.terminator.onSessionUpdated((s) => get().upsert(s))
    window.terminator.onSessionRemoved((id) => get().remove(id))
    window.terminator.onNavJump((id) => get().openSession(id))
  },

  upsert(s) {
    set((st) => {
      const isNew = !st.sessions[s.id]
      const sessions = { ...st.sessions, [s.id]: s }
      return {
        sessions,
        order: isNew ? insertInOrder(st.order, sessions, s) : st.order,
      }
    })
  },

  remove(id) {
    // Tear down any editor CodeMirror instances/state for this session (no-op otherwise).
    editor.disposeSession(id)
    set((st) => {
      const sessions = { ...st.sessions }
      delete sessions[id]
      const order = st.order.filter((x) => x !== id)
      const shown = new Set(st.panes.filter((p) => p && p !== id))
      const backfill = () => order.find((oid) => !shown.has(oid)) ?? ''
      const panes = st.panes.map((p) => {
        if (p !== id) return p
        const next = backfill()
        if (next) shown.add(next)
        return next
      })
      return {
        sessions,
        order,
        panes,
        focused: Math.min(st.focused, Math.max(0, panes.length - 1)),
        confirm: st.confirm?.id === id ? null : st.confirm,
        editingId: st.editingId === id ? null : st.editingId,
      }
    })
  },

  setLayout(name) {
    const count = LAYOUT_COUNT[name]
    set((st) => {
      let panes = st.panes.slice()
      let focused = st.focused
      if (panes.length > count) {
        // Shrinking: keep the focused pane first, then the rest.
        const focusId = panes[focused] || ''
        const others = panes.filter((_, i) => i !== focused)
        panes = [focusId, ...others].slice(0, count)
        focused = 0
      } else {
        // Growing: add empty panes — let the user choose what goes in them
        // (don't auto-fill, which used to strand the focused pane empty).
        while (panes.length < count) panes.push('')
      }
      if (!panes.length) panes = emptyPanes(count)
      if (focused >= panes.length) focused = 0
      return { layout: name, panes, focused, editingId: null }
    })
  },

  openSession(id) {
    set((st) => {
      const panes = st.panes.length ? st.panes.slice() : ['']
      const existing = panes.indexOf(id)
      let focused = st.focused
      if (existing >= 0) {
        // Already on screen — just focus its pane.
        focused = existing
      } else if (!panes[focused]) {
        // Focused split is empty — open it here.
        panes[focused] = id
      } else {
        // Focused split is occupied: fill the next empty split if there is one
        // (so a second session lands beside the first), else replace the focused.
        const emptyIdx = panes.indexOf('')
        if (emptyIdx >= 0) {
          panes[emptyIdx] = id
          focused = emptyIdx
        } else {
          panes[focused] = id
        }
      }
      const cur = st.sessions[id]
      if (cur?.notified) window.terminator.clearNotified(id)
      const sessions =
        cur && cur.notified ? { ...st.sessions, [id]: { ...cur, notified: false } } : st.sessions
      return { panes, focused, sessions, editingId: null }
    })
  },

  reorderWithinGroup(draggedId, targetId) {
    if (draggedId === targetId) return
    set((st) => {
      const a = st.sessions[draggedId]
      const b = st.sessions[targetId]
      if (!a || !b || !canReorderOnto(a, b)) return {}
      // A session drags its branches along, so subtrees stay contiguous.
      const block = subtreeIds(st.order, st.sessions, draggedId)
      const order = st.order.filter((x) => !block.includes(x))
      const ti = order.indexOf(targetId)
      if (ti < 0) return {}
      order.splice(ti, 0, ...block)
      window.terminator.reorderSessions(order)
      return { order }
    })
  },

  focusPane(i) {
    set((st) => (i === st.focused ? {} : { focused: i, editingId: null }))
  },

  toggleGroup(name) {
    set((st) => ({ collapsed: { ...st.collapsed, [name]: !st.collapsed[name] } }))
  },

  startEdit(id) {
    set({ editingId: id })
  },

  setShowNew(v) {
    set({ showNew: v })
  },
  setShowSettings(v) {
    set({ showSettings: v })
  },
  setShowNotes(v) {
    set({ showNotes: v })
  },
  setBranchFor(id) {
    set({ branchFor: id })
  },
  toggleSidebar() {
    set((s) => ({ sidebarHidden: !s.sidebarHidden }))
  },
  setConfirm(c) {
    set({ confirm: c })
  },
  setSettings(s) {
    set({ settings: s })
  },
}))

/** Whether `id` sits anywhere under `ancestorId` in the branch tree. */
function isDescendantOf(id: string, ancestorId: string, sessions: Record<string, Session>): boolean {
  let cur = sessions[id]?.parentId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true
    seen.add(cur)
    cur = sessions[cur]?.parentId
  }
  return false
}

/**
 * Where a newly arrived session goes in the display order: a branch lands right
 * after its parent's existing subtree (mirroring state.ts, which does the same to
 * the persisted order), anything else at the end.
 */
function insertInOrder(order: string[], sessions: Record<string, Session>, s: Session): string[] {
  const parentId = s.parentId
  if (!parentId) return [...order, s.id]
  const at = order.indexOf(parentId)
  if (at < 0) return [...order, s.id]
  let insert = at + 1
  while (insert < order.length && isDescendantOf(order[insert], parentId, sessions)) insert++
  const next = order.slice()
  next.splice(insert, 0, s.id)
  return next
}

/**
 * A session plus its branches, as the contiguous run they occupy in `order`.
 * Both the main process and `insertInOrder` keep subtrees contiguous.
 */
export function subtreeIds(
  order: string[],
  sessions: Record<string, Session>,
  rootId: string,
): string[] {
  const at = order.indexOf(rootId)
  if (at < 0) return [rootId]
  const ids = [rootId]
  for (let i = at + 1; i < order.length && isDescendantOf(order[i], rootId, sessions); i++) {
    ids.push(order[i])
  }
  return ids
}

/**
 * Whether a drag-reorder is allowed: same project group, and siblings under the
 * same parent — dropping a branch outside its parent's subtree would leave the
 * tree unreadable rather than reordered.
 */
export function canReorderOnto(dragged: Session, target: Session): boolean {
  if (dragged.projectName !== target.projectName) return false
  return (dragged.parentId ?? null) === (target.parentId ?? null)
}

/**
 * Sessions grouped by project, preserving creation order. Takes the stable
 * `order` and `sessions` slices so callers can wrap it in useMemo — returning a
 * fresh array straight from a zustand selector would loop useSyncExternalStore.
 */
export function buildGroups(order: string[], sessions: Record<string, Session>): ProjectGroup[] {
  const groups: ProjectGroup[] = []
  const byName = new Map<string, ProjectGroup>()
  for (const id of order) {
    const s = sessions[id]
    if (!s) continue
    let g = byName.get(s.projectName)
    if (!g) {
      g = { name: s.projectName, sessions: [], depth: {} }
      byName.set(s.projectName, g)
      groups.push(g)
    }
    g.sessions.push(s)
    // Branches follow their parent in `order`, so one forward pass is enough.
    // Depth is capped so a long chain can't indent a row off the sidebar.
    const parentDepth = s.parentId ? g.depth[s.parentId] : undefined
    g.depth[s.id] = parentDepth === undefined ? 0 : Math.min(parentDepth + 1, 4)
  }
  return groups
}

/**
 * A project group's visible sidebar lines: sessions whose parents are all
 * expanded, each carrying its branch count and, when collapsed, whether a hidden
 * branch under it needs attention — so the "which session needs me" signal never
 * disappears behind a collapsed subtree.
 */
export function buildRows(group: ProjectGroup, collapsed: Record<string, boolean>): SidebarRow[] {
  const byId = new Map(group.sessions.map((s) => [s.id, s]))
  const children = new Map<string, Session[]>()
  for (const s of group.sessions) {
    if (!s.parentId || !byId.has(s.parentId)) continue
    const list = children.get(s.parentId)
    if (list) list.push(s)
    else children.set(s.parentId, [s])
  }

  const isCollapsed = (id: string): boolean => !!collapsed[branchKey(id)]
  const hiddenUnder = (id: string): boolean => {
    const stack = [...(children.get(id) ?? [])]
    while (stack.length) {
      const s = stack.pop()!
      if (s.notified) return true
      stack.push(...(children.get(s.id) ?? []))
    }
    return false
  }
  const anyAncestorCollapsed = (s: Session): boolean => {
    let cur = s.parentId
    const seen = new Set<string>()
    while (cur && byId.has(cur) && !seen.has(cur)) {
      if (isCollapsed(cur)) return true
      seen.add(cur)
      cur = byId.get(cur)?.parentId
    }
    return false
  }

  const rows: SidebarRow[] = []
  for (const s of group.sessions) {
    if (anyAncestorCollapsed(s)) continue
    const collapsedHere = isCollapsed(s.id)
    rows.push({
      session: s,
      depth: group.depth[s.id] ?? 0,
      branches: children.get(s.id)?.length ?? 0,
      collapsed: collapsedHere,
      hiddenNotified: collapsedHere && hiddenUnder(s.id),
    })
  }
  return rows
}

/** `collapsed` key for a session's branch subtree (project groups key by name). */
export function branchKey(id: string): string {
  return `br:${id}`
}
