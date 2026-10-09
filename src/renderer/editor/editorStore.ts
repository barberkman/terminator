import { create } from 'zustand'
import type { DirEntry } from '../../shared/types'

// Serializable projection of an Editor session's UI: open tabs, the active tab,
// per-tab flags, and the lazily-listed file tree. The live CodeMirror instances
// live in the module registry (registry.ts), never here — this store only holds
// what React needs to render (so the store stays plain + serializable).

export type TabStatus = 'ok' | 'missing' | 'binary' | 'tooLarge'

export interface Tab {
  /** Absolute path — the tab's identity. */
  path: string
  /** Basename, shown on the tab. */
  name: string
  /** Has unsaved edits (doc differs from the on-disk baseline). */
  dirty: boolean
  /** Changed on disk while it had unsaved edits (non-destructive reload prompt). */
  changedOnDisk: boolean
  status: TabStatus
  /**
   * A preview tab: what a single click in the file tree opens. It is temporary —
   * the next preview open replaces it in the same slot — until editing the file or
   * double-clicking it (in the tree or on the tab) keeps it open. At most one per session.
   */
  preview: boolean
}

export interface SessionEditor {
  openPaths: string[]
  activePath: string | null
  tabs: Record<string, Tab>
  /** dir path -> expanded in the tree. */
  expanded: Record<string, boolean>
  /** dir path -> cached listing. */
  listings: Record<string, DirEntry[]>
  /** File tree folded down to a rail. Here rather than in the pane so a layout change keeps it. */
  treeHidden: boolean
}

function emptySession(): SessionEditor {
  return { openPaths: [], activePath: null, tabs: {}, expanded: {}, listings: {}, treeHidden: false }
}

interface EditorStoreState {
  sessions: Record<string, SessionEditor>
  ensure(id: string): void
  openTab(id: string, tab: Tab, replace?: string): void
  closeTab(id: string, path: string): void
  setActive(id: string, path: string): void
  patchTab(id: string, path: string, patch: Partial<Tab>): void
  setListing(id: string, dir: string, entries: DirEntry[]): void
  setExpanded(id: string, dir: string, expanded: boolean): void
  setTreeHidden(id: string, hidden: boolean): void
  clearSession(id: string): void
}

/** Update one session immutably, leaving the others untouched by reference. */
function withSession(
  state: EditorStoreState,
  id: string,
  fn: (s: SessionEditor) => SessionEditor,
): Partial<EditorStoreState> {
  const cur = state.sessions[id] ?? emptySession()
  return { sessions: { ...state.sessions, [id]: fn(cur) } }
}

export const useEditorStore = create<EditorStoreState>((set) => ({
  sessions: {},

  ensure(id) {
    set((st) => (st.sessions[id] ? {} : { sessions: { ...st.sessions, [id]: emptySession() } }))
  },

  openTab(id, tab, replace) {
    set((st) =>
      withSession(st, id, (s) => {
        // `replace` is the preview tab this one takes over: same slot, the old one gone.
        if (replace && replace !== tab.path && s.tabs[replace] && !s.tabs[tab.path]) {
          const tabs = { ...s.tabs, [tab.path]: tab }
          delete tabs[replace]
          return {
            ...s,
            openPaths: s.openPaths.map((p) => (p === replace ? tab.path : p)),
            tabs,
            activePath: tab.path,
          }
        }
        const exists = !!s.tabs[tab.path]
        return {
          ...s,
          openPaths: exists ? s.openPaths : [...s.openPaths, tab.path],
          tabs: { ...s.tabs, [tab.path]: tab },
          activePath: tab.path,
        }
      }),
    )
  },

  closeTab(id, path) {
    set((st) =>
      withSession(st, id, (s) => {
        if (!s.tabs[path]) return s
        const idx = s.openPaths.indexOf(path)
        const openPaths = s.openPaths.filter((p) => p !== path)
        const tabs = { ...s.tabs }
        delete tabs[path]
        let activePath = s.activePath
        if (activePath === path) {
          // Focus the neighbor that took this tab's slot (or the last remaining).
          activePath = openPaths[Math.min(idx, openPaths.length - 1)] ?? null
        }
        return { ...s, openPaths, tabs, activePath }
      }),
    )
  },

  setActive(id, path) {
    set((st) => withSession(st, id, (s) => (s.activePath === path ? s : { ...s, activePath: path })))
  },

  patchTab(id, path, patch) {
    set((st) =>
      withSession(st, id, (s) => {
        const t = s.tabs[path]
        if (!t) return s
        return { ...s, tabs: { ...s.tabs, [path]: { ...t, ...patch } } }
      }),
    )
  },

  setListing(id, dir, entries) {
    set((st) => withSession(st, id, (s) => ({ ...s, listings: { ...s.listings, [dir]: entries } })))
  },

  setExpanded(id, dir, expanded) {
    set((st) => withSession(st, id, (s) => ({ ...s, expanded: { ...s.expanded, [dir]: expanded } })))
  },

  setTreeHidden(id, hidden) {
    set((st) => withSession(st, id, (s) => (s.treeHidden === hidden ? s : { ...s, treeHidden: hidden })))
  },

  clearSession(id) {
    set((st) => {
      if (!st.sessions[id]) return {}
      const sessions = { ...st.sessions }
      delete sessions[id]
      return { sessions }
    })
  },
}))
