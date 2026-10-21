// What the sidebar shows, as data: its groups in order, and the word for each
// status dot. Shared so `terminator list` prints exactly the rows and words the
// window does — the renderer re-exports both from where they used to live.

import type { Session, SessionRuntime, SessionStatus } from './types'
import { groupKey } from './wsl-path'

export interface ProjectGroup {
  /** What the header says. */
  name: string
  /**
   * What the group *is* (see `groupKey`): the name for a Windows project, the name
   * and distro for a WSL one. Collapse state and "the sessions in this group" go by it.
   */
  key: string
  /** Set when the group's project lives inside WSL. */
  runtime?: SessionRuntime
  sessions: Session[]
  /** Nesting depth per session id — a branch sits one level under its parent. */
  depth: Record<string, number>
}

/** What a status dot is called — its tooltip, the pane header, `terminator list`. */
export const STATUS_LABELS: Record<SessionStatus, string> = {
  busy: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  error: 'Error',
  closed: 'Closed',
}

/**
 * Sessions grouped by project, preserving creation order. Takes the stable
 * `order` and `sessions` slices so callers can wrap it in useMemo — returning a
 * fresh array straight from a zustand selector would loop useSyncExternalStore.
 */
export function buildGroups(order: string[], sessions: Record<string, Session>): ProjectGroup[] {
  const groups: ProjectGroup[] = []
  const byKey = new Map<string, ProjectGroup>()
  for (const id of order) {
    const s = sessions[id]
    if (!s) continue
    const key = groupKey(s)
    let g = byKey.get(key)
    if (!g) {
      g = { name: s.projectName, key, runtime: s.runtime, sessions: [], depth: {} }
      byKey.set(key, g)
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
