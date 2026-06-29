import { homedir } from 'node:os'
import { join } from 'node:path'
import * as pty from '@lydell/node-pty'
import type { BrowserWindow } from 'electron'
import { Channels } from '../shared/channels'
import { defaultShell } from './shell'

interface PtyCreateOpts {
  id: string
  file?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

interface Term {
  proc: pty.IPty
  buf: string
  flush: NodeJS.Timeout | null
}

const terms = new Map<string, Term>()
/** Last known size per session, kept across restarts so a relaunch can reuse it. */
const lastSize = new Map<string, { cols: number; rows: number }>()
/** One-shot callbacks to run after a specific pty exits (used by mode switch). */
const pendingExit = new Map<string, () => void>()

/** Coalesce window for pty output, ~1 frame. Avoids one IPC message per tiny write. */
const FLUSH_MS = 8

// Main-side observers (status/activity tracking in state.ts), separate from the
// renderer IPC stream.
type DataListener = (id: string) => void
type ExitListener = (id: string, exitCode: number, signal?: number) => void
const dataListeners: DataListener[] = []
const exitListeners: ExitListener[] = []

export function onData(cb: DataListener): void {
  dataListeners.push(cb)
}
export function onExit(cb: ExitListener): void {
  exitListeners.push(cb)
}

/** Expand a leading ~ so user-typed folders like ~/code/x resolve correctly. */
export function expandHome(p?: string): string | undefined {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function cleanEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // Strip Claude Code's "running inside an agent" markers. If Terminator is itself
  // launched from a Claude Code session, these would be inherited by the `claude`
  // we spawn, which then runs as a nested session and does NOT persist its
  // transcript — breaking mode-switch resume. Remove them so claude is top-level.
  for (const k of Object.keys(env)) {
    if (/^CLAUDECODE$|^CLAUDE_CODE/i.test(k)) delete env[k]
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...(extra ?? {}) }
}

export function createPty(win: BrowserWindow, opts: PtyCreateOpts): string {
  const { id } = opts
  // A login shell with no args; explicit args win if provided.
  const file = opts.file || defaultShell()
  const proc = pty.spawn(file, opts.args ?? [], {
    name: 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: expandHome(opts.cwd) || process.env.HOME || process.cwd(),
    env: cleanEnv(opts.env),
  })

  const term: Term = { proc, buf: '', flush: null }
  terms.set(id, term)
  lastSize.set(id, { cols: opts.cols ?? 80, rows: opts.rows ?? 24 })

  const send = (channel: string, payload: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  proc.onData((data) => {
    term.buf += data
    for (const l of dataListeners) l(id)
    if (term.flush) return
    term.flush = setTimeout(() => {
      const out = term.buf
      term.buf = ''
      term.flush = null
      send(Channels.ptyData, { id, data: out })
    }, FLUSH_MS)
  })

  proc.onExit(({ exitCode, signal }) => {
    if (term.flush) {
      clearTimeout(term.flush)
      term.flush = null
    }
    if (term.buf) {
      send(Channels.ptyData, { id, data: term.buf })
      term.buf = ''
    }
    terms.delete(id)
    send(Channels.ptyExit, { id, exitCode, signal })
    for (const l of exitListeners) l(id, exitCode, signal)
    const cb = pendingExit.get(id)
    if (cb) {
      pendingExit.delete(id)
      cb()
    }
  })

  return id
}

export function writePty(id: string, data: string): void {
  terms.get(id)?.proc.write(data)
}

export function resizePty(id: string, cols: number, rows: number): void {
  lastSize.set(id, { cols, rows })
  const term = terms.get(id)
  if (!term) return
  try {
    term.proc.resize(Math.max(1, cols), Math.max(1, rows))
  } catch {
    // resize can race with exit; ignore.
  }
}

export function lastSizeOf(id: string): { cols: number; rows: number } {
  return lastSize.get(id) ?? { cols: 80, rows: 24 }
}

/** Kill a pty and run `cb` once it has actually exited (for relaunch/mode switch). */
export function killPtyThen(id: string, cb: () => void): void {
  if (!terms.has(id)) {
    cb()
    return
  }
  pendingExit.set(id, cb)
  killPty(id)
}

export function killPty(id: string): void {
  const term = terms.get(id)
  if (!term) return
  try {
    term.proc.kill()
  } catch {
    // already gone
  }
  terms.delete(id)
}

export function killAll(): void {
  for (const term of terms.values()) {
    try {
      term.proc.kill()
    } catch {
      // ignore
    }
  }
  terms.clear()
}
