import { create } from 'zustand'
import type { AttachedItem, Session, Settings, UsageSnapshot } from '../../shared/types'
import { type CustomTheme, setCustomThemes as publishThemes } from '../../shared/themes'
import type { IconName } from '../icons'
import * as editor from '../editor/registry'

export type LayoutName = 'single' | 'cols2' | 'grid4'
export const LAYOUT_COUNT: Record<LayoutName, number> = { single: 1, cols2: 2, grid4: 4 }

/** Human name per split, index-aligned with `panes`. */
export const PANE_LABELS: Record<LayoutName, string[]> = {
  single: ['Pane'],
  cols2: ['Left', 'Right'],
  grid4: ['Top left', 'Top right', 'Bottom left', 'Bottom right'],
}

/**
 * What a context menu was opened on. Sessions are a *list* from the start, even
 * though every call site passes exactly one id today: selecting several rows and
 * acting on them together is a wanted future, and this is the shape that makes it
 * new state feeding the menu rather than a rewrite of every action in it.
 */
export type MenuTarget =
  | { kind: 'sessions'; ids: string[] }
  | { kind: 'project'; name: string; path: string }

export interface ContextMenuState {
  target: MenuTarget
  /** Viewport coordinates of the click that opened it. */
  x: number
  y: number
}

/** Seed values for the New Session dialog when it's opened from a menu. */
export interface NewPrefill {
  projectPath: string
  projectName?: string
}

/**
 * Which surface owns the rename input. `editingId` is global, so without this a
 * session that is both open in a pane and visible in the sidebar would render two
 * autofocused inputs fighting over one name.
 */
export type EditSurface = 'pane' | 'sidebar'

export interface ConfirmState {
  kind: 'close' | 'remove' | 'worktree'
  id: string
  name: string
  /** For a worktree prompt reached via close/remove: also remove the session after. */
  removeAfter?: boolean
}

/**
 * A prompt typed into the conversation view's composer and handed to the pty,
 * waiting to turn up in the session's transcript.
 *
 * It exists because there is no receipt: nothing comes back up a pty to say a
 * prompt was accepted, and the transcript is only read every 700ms — and not at
 * all until Claude finishes the turn a mid-turn message was queued behind. So
 * the message is shown from the moment it is sent and retired when the real
 * record arrives (ConversationView reconciles the two).
 *
 * Kept in the store rather than in the view because Esc unmounts the view, and a
 * message in flight must not vanish with it.
 */
export interface PendingPrompt {
  /** Ours, never a transcript uuid — these have no id until they land. */
  key: string
  /** Exactly what `sendPrompt` wrote, which is what the transcript is matched against. */
  text: string
  /**
   * The typed message alone, set only when attachment paths were folded in front
   * of it. Needed because the TUI rewrites an image path it recognises into an
   * `[Image #1]` chip, so what lands in the transcript is not what was sent and
   * `text` can never match it — but the words after it still do.
   */
  message?: string
  sentAt: number
  /**
   * Time the session has spent *not busy* since this was sent. A prompt queued
   * behind a long turn is normal and must never be called lost, so the clock
   * only runs while there is nothing to wait for.
   */
  quietMs: number
  state: 'pending' | 'unsure'
}

/**
 * A transient message in the bottom-right corner. The only place the app can tell
 * you an attachment landed (a terminal can't show a thumbnail) — or why it didn't.
 */
export interface ToastItem {
  id: number
  tone: 'ok' | 'error'
  text: string
  sub?: string
  /** data: URL preview of an attached image. */
  thumb?: string
  /** Glyph for a toast that isn't about an attachment. Defaults to the paperclip. */
  icon?: IconName
  /**
   * The attachment this toast can act on — the path main will accept back. Its
   * absence is what makes a card inert rather than disabled: a toast with nothing
   * to open loses the button entirely instead of greying one out, the same bargain
   * the context menu makes by having no `disabled` variant at all.
   *
   * Only a single-item attach sets it. A multi-item one lists names rather than a
   * path, and an error has nothing to point at.
   *
   * `kind` is here to word the label, not to decide anything: main re-reads what's
   * actually on disk before it opens, so this copy is never load-bearing.
   */
  action?: { path: string; kind: AttachedItem['kind'] }
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
  /** Id of the custom theme the theme editor is open on, if any. */
  themeEditorFor: string | null
  /** Session whose conversation the branch picker is open for. */
  branchFor: string | null
  /**
   * Sessions the startup prompt is offering to relaunch, in sidebar order. Null
   * whenever the prompt isn't up — which is every run unless `relaunchOnStartup`
   * is on and `init` found something left over from last time.
   */
  relaunchOffer: string[] | null
  /**
   * Sessions whose pane is showing the conversation instead of the terminal.
   * Keyed by session id, not pane index, so the choice follows a session when it
   * moves panes — and the terminal underneath is never torn down either way.
   */
  transcripts: Record<string, boolean>
  /**
   * Whether conversation views draw tool calls, or just the exchange. One flag for
   * the whole app, not one per session: wanting to see what Claude ran is a way of
   * reading, not a property of a particular conversation, and re-flipping it for
   * every pane you glance at is friction with nothing on the other side of it.
   *
   * Thinking is deliberately not governed by this. It was hidden alongside tool
   * calls at first, but a collapsed one-line "Thinking" was never the wall of
   * shell commands the hiding was aimed at — and it is the first thing to appear
   * after a prompt, so hiding it took away the earliest sign of life.
   */
  showTools: boolean
  /** Unsent composer text, so a half-typed message survives a trip to the terminal. */
  drafts: Record<string, string>
  /** Prompts sent from the composer that haven't turned up in the transcript yet. */
  pendings: Record<string, PendingPrompt[]>
  /** Files and images attached to the next message, per session. */
  attachments: Record<string, AttachedItem[]>
  sidebarHidden: boolean
  editingId: string | null
  editingWhere: EditSurface
  confirm: ConfirmState | null
  contextMenu: ContextMenuState | null
  newPrefill: NewPrefill | null
  settings: Settings | null
  /** The user's own themes. Mirrored into shared/themes.ts by `setCustomThemes`. */
  customThemes: CustomTheme[]
  /**
   * Claude's rate-limit windows — one account-wide value, not one per session, so
   * the footer reads the same whichever pane has focus. Null until `init` hydrates it.
   */
  usage: UsageSnapshot | null
  toasts: ToastItem[]

  init(): Promise<void>
  upsert(s: Session): void
  remove(id: string): void
  setLayout(name: LayoutName): void
  openSession(id: string): void
  openInPane(id: string, index: number): void
  reorderWithinGroup(draggedId: string, targetId: string): void
  focusPane(i: number): void
  toggleGroup(name: string): void
  startEdit(id: string | null, where?: EditSurface): void
  setShowNew(v: boolean, prefill?: NewPrefill): void
  openContextMenu(m: ContextMenuState): void
  closeContextMenu(): void
  setShowSettings(v: boolean): void
  setShowNotes(v: boolean): void
  setThemeEditorFor(id: string | null): void
  setBranchFor(id: string | null): void
  setRelaunchOffer(ids: string[] | null): void
  toggleTranscript(id: string): void
  toggleTools(): void
  setDraft(id: string, text: string): void
  setPendings(id: string, list: PendingPrompt[]): void
  setAttachments(id: string, list: AttachedItem[]): void
  toggleSidebar(): void
  setConfirm(c: ConfirmState | null): void
  setSettings(s: Settings): void
  setCustomThemes(list: CustomTheme[]): void
  setUsage(u: UsageSnapshot): void
  pushToast(t: Omit<ToastItem, 'id'>): void
  dismissToast(id: number): void
}

function emptyPanes(count: number): string[] {
  return Array.from({ length: count }, () => '')
}

let initialized = false
let nextToastId = 1

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
  themeEditorFor: null,
  branchFor: null,
  relaunchOffer: null,
  transcripts: {},
  showTools: false,
  drafts: {},
  pendings: {},
  attachments: {},
  sidebarHidden: false,
  editingId: null,
  editingWhere: 'pane',
  confirm: null,
  contextMenu: null,
  newPrefill: null,
  settings: null,
  customThemes: [],
  usage: null,
  toasts: [],

  async init() {
    if (initialized) return
    initialized = true
    const [list, settings, themes, usage] = await Promise.all([
      window.terminator.listSessions(),
      window.terminator.getSettings(),
      window.terminator.getCustomThemes(),
      // Pulled as well as subscribed to below: this is where the numbers a previous
      // run left on disk come from, and it also covers a report that landed before
      // the subscription existed.
      window.terminator.getUsage(),
    ])
    // main.tsx already published these before the first paint; doing it again is
    // idempotent and keeps the one code path that owns the mirror.
    get().setCustomThemes(themes)
    const sessions: Record<string, Session> = {}
    const order: string[] = []
    for (const s of list) {
      sessions[s.id] = s
      order.push(s.id)
    }
    const panes = order.length ? [order[0]] : ['']
    // Opt-in, and only when there is something to offer: with the setting off, or
    // nothing left over from last time, startup is exactly what it always was.
    const restorable = settings.relaunchOnStartup
      ? order.filter((id) => isRestorable(sessions[id]))
      : []
    set({
      sessions,
      order,
      settings,
      panes,
      usage,
      relaunchOffer: restorable.length ? restorable : null,
    })

    window.terminator.onSessionUpdated((s) => get().upsert(s))
    window.terminator.onSessionRemoved((id) => get().remove(id))
    window.terminator.onNavJump((id) => get().openSession(id))
    window.terminator.onUsageUpdated((u) => get().setUsage(u))
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
      const transcripts = { ...st.transcripts }
      delete transcripts[id]
      const drafts = { ...st.drafts }
      delete drafts[id]
      const pendings = { ...st.pendings }
      delete pendings[id]
      const attachments = { ...st.attachments }
      delete attachments[id]
      return {
        sessions,
        order,
        panes,
        transcripts,
        drafts,
        pendings,
        attachments,
        focused: Math.min(st.focused, Math.max(0, panes.length - 1)),
        confirm: st.confirm?.id === id ? null : st.confirm,
        contextMenu:
          st.contextMenu?.target.kind === 'sessions' && st.contextMenu.target.ids.includes(id)
            ? null
            : st.contextMenu,
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

  /**
   * Put a session in one named split, rather than letting openSession choose. It
   * vacates any other pane holding it first: `remove()`'s backfill assumes a
   * session appears in `panes` at most once, and one xterm host element can only
   * live in one pane anyway.
   */
  openInPane(id, index) {
    set((st) => {
      if (index < 0 || index >= st.panes.length) return {}
      const panes = st.panes.slice()
      const prev = panes.indexOf(id)
      if (prev >= 0 && prev !== index) panes[prev] = ''
      panes[index] = id
      const cur = st.sessions[id]
      if (cur?.notified) window.terminator.clearNotified(id)
      const sessions =
        cur && cur.notified ? { ...st.sessions, [id]: { ...cur, notified: false } } : st.sessions
      return { panes, focused: index, sessions, editingId: null }
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

  startEdit(id, where = 'pane') {
    set({ editingId: id, editingWhere: where })
  },

  setShowNew(v, prefill) {
    set({ showNew: v, newPrefill: v ? (prefill ?? null) : null })
  },

  openContextMenu(m) {
    // Deliberately touches nothing else: a right-click is not an open, so panes,
    // focus, `notified` and any in-progress rename are all left alone.
    set({ contextMenu: m })
  },
  closeContextMenu() {
    set({ contextMenu: null })
  },
  setShowSettings(v) {
    set({ showSettings: v })
  },
  setShowNotes(v) {
    set({ showNotes: v })
  },
  setThemeEditorFor(id) {
    set({ themeEditorFor: id })
  },
  setBranchFor(id) {
    set({ branchFor: id })
  },
  setRelaunchOffer(ids) {
    set({ relaunchOffer: ids })
  },
  toggleTranscript(id) {
    set((st) => ({ transcripts: { ...st.transcripts, [id]: !st.transcripts[id] } }))
  },
  toggleTools() {
    set((st) => ({ showTools: !st.showTools }))
  },
  setDraft(id, text) {
    set((st) => ({ drafts: { ...st.drafts, [id]: text } }))
  },
  setPendings(id, list) {
    set((st) => ({ pendings: { ...st.pendings, [id]: list } }))
  },
  setAttachments(id, list) {
    set((st) => ({ attachments: { ...st.attachments, [id]: list } }))
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
  /**
   * The store holds the themes so React re-renders on a change; shared/themes.ts
   * holds them so `resolveTheme` can find one by id. Both are set here, so the
   * lookup can never be a step behind what the picker is showing.
   */
  setCustomThemes(list) {
    publishThemes(list)
    set({ customThemes: list })
  },
  setUsage(u) {
    set({ usage: u })
  },
  pushToast(t) {
    // Newest first, and never more than a few on screen at once.
    set((st) => ({ toasts: [{ ...t, id: nextToastId++ }, ...st.toasts].slice(0, 4) }))
  },
  dismissToast(id) {
    set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }))
  },
}))

/**
 * Whether a session is one the startup prompt can bring back: it has a process
 * behind it (an editor session has none — it restores immediately usable), it
 * isn't running, and it ran at least once, so starting it is a *re*-start. That
 * last pair is the same test the pane's own Relaunch overlay uses.
 */
export function isRestorable(s: Session | undefined): boolean {
  return !!s && s.kind !== 'editor' && !s.alive && s.everStarted
}

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
