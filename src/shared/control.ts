// What the `terminator` command and the app say to each other.
//
// Types only, on purpose: the CLI is bundled on its own (see electron.vite.config.ts)
// and must not pull a shared chunk in at run time, so anything both sides need as a
// *value* is pinned here as a literal type instead — `protocol: ControlProtocol`
// makes each side write the number, and the compiler holds them to the same one.

import type { SessionKind, SessionRuntime } from './types'

/** Bumped when a request or response changes shape. */
export type ControlProtocol = 1

/** What `<userData>/control.json` holds while scripting is on and the app is running. */
export interface ControlFile {
  port: number
  token: string
  pid: number
  protocol: ControlProtocol
}

/** The words a status dot carries, as the command prints them. */
export type StatusWord = 'idle' | 'working' | 'waiting' | 'error' | 'closed'

export type SplitSide = 'left' | 'right' | 'up' | 'down'

/** One row of `terminator list` — what the sidebar shows about a session. */
export interface ListedSession {
  id: string
  name: string
  kind: SessionKind
  project: string
  branch: string
  status: StatusWord
}

/** Every request body carries the protocol it was written for. */
interface Req {
  protocol: ControlProtocol
}

export interface ControlRequests {
  list: Req
  new: Req & {
    kind: 'claude' | 'shell'
    project: string
    name?: string
    worktree?: boolean
    branch?: string
    split?: SplitSide
    /** Set by the WSL shim: `project` is a Linux path in this distro. */
    runtime?: SessionRuntime
  }
  send: Req & { session: string; text: string }
  wait: Req & { session: string; statuses: StatusWord[]; timeoutMs?: number }
  reply: Req & { session: string }
  stop: Req & { session: string }
  remove: Req & { session: string; removeWorktree?: boolean }
}

export type ControlCommand = keyof ControlRequests

export type ControlFailure = {
  ok: false
  error: string
  /** `new` only: the session exists even though what was asked of it failed. */
  id?: string
  /** `wait` only: the timeout ran out first; `status` is where the session stands. */
  timedOut?: boolean
  status?: StatusWord
}

export interface ControlResults {
  list: { ok: true; sessions: ListedSession[] }
  new: { ok: true; id: string; session: ListedSession }
  send: { ok: true }
  wait: { ok: true; status: StatusWord; warning?: string }
  reply: { ok: true; markdown: string }
  stop: { ok: true }
  remove: { ok: true }
}

export type ControlResponse<C extends ControlCommand = ControlCommand> = ControlResults[C] | ControlFailure

/**
 * main -> renderer: the one command main can't carry out alone. Creating a session
 * is the New Session dialog's sequence, and the panes it lands in are the
 * renderer's; see renderer/scripting.ts.
 */
export interface BridgeNewArgs {
  name: string
  folder: string
  kind: 'claude' | 'shell'
  worktree: boolean
  branch: string
  runtime?: SessionRuntime
  split: SplitSide
}

export type BridgeRequest = { reqId: number; cmd: 'new'; args: BridgeNewArgs }

export type BridgeReply =
  | {
      reqId: number
      ok: true
      id: string
      /** What `createSession` reported going wrong, e.g. a worktree git refused. */
      createError?: string
    }
  | { reqId: number; ok: false; error: string }
