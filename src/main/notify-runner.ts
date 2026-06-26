import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { NotificationEvent } from '../shared/types'
import { loadSettings } from './settings'
import { expandHome } from './pty-manager'
import { shellRunArgs } from './shell'

// Runs the user's configurable notification command, fire-and-forget. The command
// receives the full event as JSON on stdin plus TERMINATOR_* env vars, and runs
// through the user's shell so it resolves in their environment. Type-aware:
// the command can branch on TERMINATOR_NOTIF_TYPE (or the stdin payload's `type`).
export function runNotifyCommand(e: NotificationEvent): void {
  const settings = loadSettings()
  const n = settings.notifications
  if (!n.triggerOn.includes(e.type)) return
  const command = (n.perType?.[e.type] || n.command || '').trim()
  if (!command) return

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  Object.assign(env, {
    TERMINATOR_NOTIF_TYPE: e.type,
    TERMINATOR_SESSION_ID: e.sessionId,
    TERMINATOR_SESSION_NAME: e.name,
    TERMINATOR_PROJECT: e.project,
    TERMINATOR_BRANCH: e.branch,
    TERMINATOR_STATUS: e.status,
    TERMINATOR_KIND: e.kind,
    TERMINATOR_MODE: e.mode,
    TERMINATOR_CWD: e.cwd,
    TERMINATOR_MESSAGE: e.message,
  })

  try {
    const child = spawn(settings.defaultShell, shellRunArgs(settings.defaultShell, command), {
      cwd: expandHome(e.cwd) || undefined,
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    child.stdin.end(JSON.stringify(e))
    let err = ''
    child.stderr?.on('data', (d) => (err += d))
    const timeout = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
    }, 8000)
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code && err.trim()) logError(e, err.trim())
    })
    child.on('error', (e2) => {
      clearTimeout(timeout)
      logError(e, String(e2))
    })
  } catch (e2) {
    logError(e, String(e2))
  }
}

function logError(e: NotificationEvent, message: string): void {
  try {
    const line = `[${new Date().toISOString()}] notify(${e.type}) ${e.name}: ${message}\n`
    appendFileSync(join(app.getPath('userData'), 'notifications.log'), line)
  } catch {
    // best effort
  }
}
