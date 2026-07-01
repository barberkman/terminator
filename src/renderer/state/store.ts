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
      return {
        sessions: { ...st.sessions, [s.id]: s },
        order: isNew ? [...st.order, s.id] : st.order,
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
      // Only reorder within the same project group (keeps groups contiguous).
      if (!a || !b || a.projectName !== b.projectName) return {}
      const order = st.order.filter((x) => x !== draggedId)
      const ti = order.indexOf(targetId)
      if (ti < 0) return {}
      order.splice(ti, 0, draggedId)
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
      g = { name: s.projectName, sessions: [] }
      byName.set(s.projectName, g)
      groups.push(g)
    }
    g.sessions.push(s)
  }
  return groups
}
