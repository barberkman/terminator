import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { isProcessless, type Session } from '../shared/types'

// Persist just the durable session metadata. Runtime fields (status, alive,
// metrics, notified) are intentionally not stored — restored sessions come back
// as "not running" until the user relaunches them.
const KEYS = [
  'id',
  'name',
  'kind',
  'mode',
  'projectName',
  'projectPath',
  'branch',
  'worktreePath',
  'url',
  'everStarted',
  'createdAt',
  'parentId',
  'branchedFrom',
  'branchPoint',
] as const

/** How a restored session describes itself before anything has started it. */
function restoredActivity(kind: Session['kind']): string {
  if (kind === 'editor') return 'editing'
  if (kind === 'browser') return 'browsing'
  return 'not running'
}

function file(): string {
  return join(app.getPath('userData'), 'sessions.json')
}

export function loadPersistedSessions(): Session[] {
  const f = file()
  if (!existsSync(f)) return []
  try {
    const arr = JSON.parse(readFileSync(f, 'utf8')) as Partial<Session>[]
    return arr
      .filter((p) => p.id)
      .map((p) => ({
        id: p.id as string,
        name: p.name ?? 'session',
        kind: p.kind ?? 'shell',
        mode: p.mode ?? 'normal',
        projectName: p.projectName ?? 'project',
        projectPath: p.projectPath ?? '',
        branch: p.branch ?? 'main',
        worktreePath: p.worktreePath,
        url: p.url,
        // Editor and browser sessions have no process — they're immediately usable
        // on restore, so they come back idle rather than "closed / needs relaunch".
        status: isProcessless(p.kind ?? 'shell') ? 'idle' : 'closed',
        activity: restoredActivity(p.kind ?? 'shell'),
        notified: false,
        alive: false,
        everStarted: p.everStarted ?? true,
        metrics: p.kind === 'claude' ? {} : undefined,
        createdAt: p.createdAt ?? Date.now(),
        parentId: p.parentId,
        branchedFrom: p.branchedFrom,
        branchPoint: p.branchPoint,
      }))
  } catch {
    return []
  }
}

export function savePersistedSessions(sessions: Session[]): void {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    const data = sessions
      // Build/Run output panes are transient — don't restore them across restarts.
      .filter((s) => !s.task)
      .map((s) => {
        const o: Record<string, unknown> = {}
        for (const k of KEYS) o[k] = s[k]
        return o
      })
    const f = file()
    const tmp = `${f}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, f)
  } catch {
    // best effort
  }
}
