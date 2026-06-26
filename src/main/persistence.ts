import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Session } from '../shared/types'

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
  'everStarted',
  'createdAt',
] as const

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
        status: 'closed',
        activity: 'not running',
        notified: false,
        alive: false,
        everStarted: p.everStarted ?? true,
        metrics: p.kind === 'claude' ? {} : undefined,
        createdAt: p.createdAt ?? Date.now(),
      }))
  } catch {
    return []
  }
}

export function savePersistedSessions(sessions: Session[]): void {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    const data = sessions.map((s) => {
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
