import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import { Channels } from '../shared/channels'
import type {
  CreateSessionInput,
  NotificationEvent,
  NotifType,
  Session,
  SessionStatus,
} from '../shared/types'
import * as ptyMgr from './pty-manager'
import { closeAllForSession as closeFsWatchers } from './fs-service'
import { runNotifyCommand } from './notify-runner'
import { cancelPendingPrompt } from './prefill'
import { loadPersistedSessions, savePersistedSessions } from './persistence'

const sessions = new Map<string, Session>()
/** Sessions being relaunched (mode switch); their exit must not flip status to closed. */
const restarting = new Set<string>()
/**
 * Sessions being stopped on purpose. Without this a deliberate kill lands in the
 * non-zero-exit branch below, which sets status 'error' *and* runs the user's
 * configured notification command — raising an alarm for something they asked for.
 * (Removal is quiet only by accident of ordering: removeSession kills the pty
 * before deleting the session, so the exit arrives to find nothing left.)
 */
const stopping = new Set<string>()
let mainWindow: BrowserWindow | null = null

export function setRestarting(id: string, value: boolean): void {
  if (value) restarting.add(id)
  else restarting.delete(id)
}

export function setStopping(id: string, value: boolean): void {
  if (value) stopping.add(id)
  else stopping.delete(id)
}

/** Tell the renderer to clear a session's terminal buffer (on mode-switch relaunch). */
export function resetTerminal(id: string): void {
  emit(Channels.ptyReset, id)
}

export function setWindow(w: BrowserWindow): void {
  mainWindow = w
}

/** Load durable sessions from disk on startup (as "not running"). No emit yet. */
export function loadPersisted(): void {
  for (const s of loadPersistedSessions()) sessions.set(s.id, s)
}

let saveTimer: NodeJS.Timeout | null = null
function persist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => savePersistedSessions([...sessions.values()]), 400)
}

function emit(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

export function listSessions(): Session[] {
  // Map insertion order is the display order — preserved across restarts via
  // persistence, and re-arranged by reorderSessions (sidebar drag-reorder).
  return [...sessions.values()]
}

/** Re-arrange sessions to match a new id order (sidebar drag-reorder), then persist. */
export function reorderSessions(ids: string[]): void {
  const next = new Map<string, Session>()
  for (const id of ids) {
    const s = sessions.get(id)
    if (s) next.set(id, s)
  }
  // Keep any sessions not present in `ids` (safety) in their existing order.
  for (const [id, s] of sessions) if (!next.has(id)) next.set(id, s)
  sessions.clear()
  for (const [id, s] of next) sessions.set(id, s)
  persist()
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id)
}

/** Initial activity label per session kind. */
function initialActivity(kind: CreateSessionInput['kind']): string {
  if (kind === 'shell') return 'idle'
  if (kind === 'editor') return 'editing'
  return 'ready'
}

/** Branch metadata, set only by the branch path in ipc.ts. */
export interface BranchMeta {
  parentId: string
  branchedFrom: string
  branchPoint: number
}

/** Whether `id` sits anywhere under `ancestorId` in the branch tree. */
function isDescendantOf(id: string, ancestorId: string): boolean {
  let cur = sessions.get(id)?.parentId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true
    seen.add(cur)
    cur = sessions.get(cur)?.parentId
  }
  return false
}

/**
 * Move a freshly created branch to sit directly after its parent's existing
 * subtree, so the sidebar tree stays contiguous (Map insertion order is the
 * display order). No-op if the parent is gone.
 */
function placeAfterParent(id: string, parentId: string): void {
  const ids = [...sessions.keys()].filter((x) => x !== id)
  const at = ids.indexOf(parentId)
  if (at < 0) return
  let insert = at + 1
  while (insert < ids.length && isDescendantOf(ids[insert], parentId)) insert++
  ids.splice(insert, 0, id)
  reorderSessions(ids)
}

export function createSession(input: CreateSessionInput, branch?: BranchMeta): Session {
  const id = randomUUID()
  // Store an absolute, ~-expanded path so the editor's file ops and the renderer's
  // path identities always agree (the PTY cwd is expanded again at spawn anyway).
  const projectPath = resolve(ptyMgr.expandHome(input.projectPath) || input.projectPath)
  const projectName = input.projectName?.trim() || basename(projectPath) || 'project'
  const session: Session = {
    id,
    name: input.name?.trim() || input.task || (input.kind === 'shell' ? 'shell' : projectName),
    kind: input.kind,
    mode: input.kind === 'claude' ? input.mode : 'normal',
    task: input.task,
    projectName,
    projectPath,
    branch: input.worktree ? input.branch?.trim() || 'work' : 'main',
    worktreePath: undefined,
    status: 'idle',
    activity: initialActivity(input.kind),
    notified: false,
    alive: false,
    everStarted: false,
    metrics: input.kind === 'claude' ? {} : undefined,
    createdAt: Date.now(),
    parentId: branch?.parentId,
    branchedFrom: branch?.branchedFrom,
    branchPoint: branch?.branchPoint,
  }
  sessions.set(id, session)
  if (branch) placeAfterParent(id, branch.parentId)
  emit(Channels.sessionUpdated, session)
  persist()
  return session
}

export function updateSession(id: string, patch: Partial<Session>): Session | undefined {
  const s = sessions.get(id)
  if (!s) return undefined
  Object.assign(s, patch)
  emit(Channels.sessionUpdated, s)
  persist()
  return s
}

export function setStatus(id: string, status: SessionStatus, activity?: string): void {
  const s = sessions.get(id)
  if (!s) return
  s.status = status
  if (activity !== undefined) s.activity = activity
  // The "needs me" flag belongs to the state that raised it: leaving waiting or error
  // clears it, so the pulsing dot never outlives the reason for it. Clicking the row
  // (clearNotified) is then a way to dismiss it early, not the only way out.
  if (status !== 'waiting' && status !== 'error') s.notified = false
  emit(Channels.sessionUpdated, s)
}

export function markStarted(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  s.alive = true
  s.everStarted = true
  emit(Channels.sessionUpdated, s)
  persist()
}

/**
 * Raise a notification: highlight the session (for waiting/error), push the
 * in-app toast event to the renderer, and run the user's configurable command.
 */
export function notify(id: string, type: NotifType, message: string): void {
  const s = sessions.get(id)
  if (!s) return
  if (type === 'waiting' || type === 'error') {
    s.notified = true
    emit(Channels.sessionUpdated, s)
  }
  const event: NotificationEvent = {
    type,
    sessionId: id,
    name: s.name,
    project: s.projectName,
    branch: s.branch,
    status: s.status,
    kind: s.kind,
    mode: s.mode,
    cwd: s.worktreePath || s.projectPath,
    message,
    timestamp: Date.now(),
  }
  runNotifyCommand(event)
}

/** Clear the "needs me" flag once the user has the session in view. */
export function clearNotified(id: string): void {
  const s = sessions.get(id)
  if (!s || !s.notified) return
  s.notified = false
  emit(Channels.sessionUpdated, s)
}

export function removeSession(id: string): void {
  restarting.delete(id)
  stopping.delete(id)
  ptyMgr.killPty(id)
  closeFsWatchers(id) // no-op for non-editor sessions
  cancelPendingPrompt(id) // no-op unless a branch never started
  const grandparent = sessions.get(id)?.parentId
  if (sessions.delete(id)) {
    // Re-parent this session's branches onto its own parent so they don't vanish
    // from the tree. `branchedFrom` keeps naming the session they came from.
    for (const child of sessions.values()) {
      if (child.parentId !== id) continue
      child.parentId = grandparent
      emit(Channels.sessionUpdated, child)
    }
    emit(Channels.sessionRemoved, id)
    persist()
  }
}

// ---- Plain-shell activity + exit tracking ----------------------------------
// Claude session status is driven by hooks (M3); shells use an output-activity
// heuristic: any output => running (busy), then idle after a quiet period.

const SHELL_IDLE_MS = 800
const idleTimers = new Map<string, NodeJS.Timeout>()

export function wireProcessEvents(): void {
  ptyMgr.onData((id) => {
    const s = sessions.get(id)
    if (!s || s.kind !== 'shell') return
    if (s.status !== 'busy') setStatus(id, 'busy', 'running')
    const prev = idleTimers.get(id)
    if (prev) clearTimeout(prev)
    idleTimers.set(
      id,
      setTimeout(() => {
        idleTimers.delete(id)
        const cur = sessions.get(id)
        if (cur && cur.alive && cur.kind === 'shell') setStatus(id, 'idle', 'idle')
      }, SHELL_IDLE_MS),
    )
  })

  ptyMgr.onExit((id, exitCode) => {
    const t = idleTimers.get(id)
    if (t) {
      clearTimeout(t)
      idleTimers.delete(id)
    }
    const s = sessions.get(id)
    if (!s) return
    s.alive = false
    // Mode switch: launcher will relaunch + set status; don't mark it closed.
    if (restarting.has(id)) {
      restarting.delete(id)
      stopping.delete(id) // a stop that raced the relaunch must not outlive it
      emit(Channels.sessionUpdated, s)
      return
    }
    // Asked for: report it as closed, and raise nothing.
    if (stopping.has(id)) {
      stopping.delete(id)
      s.status = 'closed'
      s.activity = 'stopped'
      s.notified = false
      emit(Channels.sessionUpdated, s)
      return
    }
    if (exitCode && exitCode !== 0) {
      s.status = 'error'
      s.activity = `process exited (${exitCode})`
      emit(Channels.sessionUpdated, s)
      notify(id, 'error', `${s.name} exited (${exitCode})`)
    } else {
      s.status = 'closed'
      s.activity = 'exited'
      s.notified = false
      emit(Channels.sessionUpdated, s)
    }
  })
}
