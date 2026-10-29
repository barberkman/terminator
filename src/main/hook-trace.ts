// A line per hook in <userData>/hook-trace.log: what arrived, when Claude stamped
// it, and what the app made of it. A status that sticks only now and then can't be
// reproduced on demand, so the record has to be there already when it happens.
// It holds names and ids only — never a prompt, a message or a tool's input.
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { SessionStatus } from '../shared/types'

/** Past this the log moves to hook-trace.log.1, replacing the one before. */
const MAX_BYTES = 5 * 1024 * 1024

let file = ''
let size = -1

export interface TraceLine {
  /** The session, shortened. */
  s: string
  /** The hook event, or the app's own name for what moved the status. */
  ev: string
  /** When Claude spawned the report, for a hook. */
  at?: number
  /** What was done with it: applied, or why not. */
  d: string
  from?: SessionStatus
  to?: SessionStatus
  [field: string]: unknown
}

export function trace(line: TraceLine): void {
  try {
    if (!file) file = join(app.getPath('userData'), 'hook-trace.log')
    if (size < 0) {
      try {
        size = statSync(file).size
      } catch {
        size = 0
      }
    }
    if (size > MAX_BYTES) {
      renameSync(file, `${file}.1`)
      size = 0
    }
    const text = `${JSON.stringify({ t: Date.now(), ...line })}\n`
    appendFileSync(file, text)
    size += Buffer.byteLength(text)
  } catch {
    // best effort: a log that can't be written must never get in the way
  }
}

/** The first 8 characters of an id, or undefined. */
export function short(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v.slice(0, 8) : undefined
}
