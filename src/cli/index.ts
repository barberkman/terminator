// The `terminator` command: drive the running Terminator from a script, the way a
// person drives it from the window.
//
// This is only the messenger. It reads the arguments, finds the running app through
// `<userData>/control.json`, and asks it; the app carries the command out through the
// same code its buttons use (src/main/scripting.ts). It runs under the app's own
// executable in Node mode and is copied out of the app on its own
// (src/main/cli-install.ts), so it uses Node's builtins and nothing else — from
// src/shared it takes types only (electron.vite.config.ts checks).

import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join, posix, resolve } from 'node:path'
import type {
  ControlCommand,
  ControlFile,
  ControlProtocol,
  ControlRequests,
  ControlResponse,
  ListedSession,
  SplitSide,
  StatusWord,
} from '../shared/control'
import type { SessionRuntime } from '../shared/types'

const PROTOCOL: ControlProtocol = 1

/** Exit codes: done, didn't, and `wait` ran out of time. */
const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_TIMEOUT = 2

const USAGE = `Usage: terminator <command> [options]

Drive the running Terminator. Turn it on in Settings > SCRIPTING.

  list                                      the sessions the sidebar shows
  new <claude|shell> --project <folder>     create a session, start it, show it beside
      [--name <name>] [--worktree [--branch <branch>]]       your pane; prints its id
      [--split left|right|up|down]
  send <session> <text>                     type a prompt and press Enter, as Send does
  wait <session> <status>... [--timeout <time>]
                                            until it's idle, working, waiting, error or
                                            closed; prints which
  reply <session>                           the latest finished reply, as Copy reply
  stop <session>                            stop its process; the session stays
  remove <session> [--remove-worktree]      remove it without asking

A session is its id, or project/name as the sidebar shows it.
--json prints one JSON value instead of text. --timeout takes 30s, 10m, 1h or 500ms.
Exit codes: 0 done, 1 failed, 2 wait timed out.`

class UsageError extends Error {}

// ---- arguments -----------------------------------------------------------------

/** Flags each command takes; `true` means the flag carries a value. */
const FLAGS: Record<ControlCommand, Record<string, boolean>> = {
  list: {},
  new: { project: true, name: true, worktree: false, branch: true, split: true },
  send: {},
  wait: { timeout: true },
  reply: {},
  stop: {},
  remove: { 'remove-worktree': false },
}

/** How many positionals each command takes: [min, max]. */
const POSITIONALS: Record<ControlCommand, [number, number]> = {
  list: [0, 0],
  new: [1, 1],
  send: [2, 2],
  wait: [2, Infinity],
  reply: [1, 1],
  stop: [1, 1],
  remove: [1, 1],
}

const NAMES: Record<ControlCommand, string> = {
  list: 'list',
  new: 'new <claude|shell>',
  send: 'send <session> <text>',
  wait: 'wait <session> <status>...',
  reply: 'reply <session>',
  stop: 'stop <session>',
  remove: 'remove <session>',
}

interface Parsed {
  cmd: ControlCommand
  pos: string[]
  flags: Record<string, string | true>
  json: boolean
}

function parse(argv: string[]): Parsed | 'help' {
  let json = false
  const words: string[] = []
  const flags: Record<string, string | true> = {}
  let i = 0
  let cmd: ControlCommand | undefined
  let endOfFlags = false
  while (i < argv.length) {
    const a = argv[i++]
    if (!endOfFlags && a === '--') {
      endOfFlags = true
      continue
    }
    if (endOfFlags || !a.startsWith('--') || a === '-') {
      if (!endOfFlags && (a === '-h' || a === 'help') && !cmd) return 'help'
      if (!cmd) {
        if (!Object.hasOwn(FLAGS, a)) throw new UsageError(`there's no ${a} command`)
        cmd = a as ControlCommand
      } else {
        words.push(a)
      }
      continue
    }
    const eq = a.indexOf('=')
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq)
    if (name === 'json') {
      json = true
      continue
    }
    if (name === 'help') return 'help'
    if (!cmd) throw new UsageError(`${a} goes after the command`)
    if (!Object.hasOwn(FLAGS[cmd], name)) throw new UsageError(`${cmd} has no --${name} option`)
    if (FLAGS[cmd][name]) {
      const value = eq < 0 ? argv[i++] : a.slice(eq + 1)
      if (value === undefined) throw new UsageError(`--${name} needs a value`)
      flags[name] = value
    } else {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`)
      flags[name] = true
    }
  }
  if (!cmd) return 'help'
  const [min, max] = POSITIONALS[cmd]
  if (words.length < min || words.length > max) {
    throw new UsageError(
      cmd === 'send' && words.length > 2
        ? 'send takes one text argument; put the prompt in quotes'
        : `usage: terminator ${NAMES[cmd]}`,
    )
  }
  return { cmd, pos: words, flags, json }
}

/** `30s`, `10m`, `1h`, `500ms`, or a bare number of seconds. */
function duration(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim())
  if (!m) throw new UsageError(`--timeout takes a time like 30s, 10m or 1h, not ${raw}`)
  const n = Number(m[1])
  const unit = m[2] ?? 's'
  return Math.round(n * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000))
}

/**
 * A `--project` as the app should hear it. Relative folders are resolved here,
 * where the command was run. The rest goes through as typed, for the app to read
 * the way the New Session dialog reads a typed folder: `~`, a WSL share, and — on
 * Windows — a bare `/…` path, which the dialog takes to be the default distro's.
 *
 * Two shells read paths their own way, and the shim says which one ran it:
 * a WSL distro (its folders are Linux ones, and the session runs there — what
 * choosing it under "Run in" does), and Git Bash (`/c/x` is `C:\x`).
 */
function project(raw: string): { project: string; runtime?: SessionRuntime } {
  const distro = process.env.TERMINATOR_WSL_DISTRO
  if (distro) {
    const pwd = process.env.TERMINATOR_WSL_PWD || '/'
    const linux = raw.startsWith('/') || raw.startsWith('~') ? raw : posix.resolve(pwd, raw)
    return { project: linux, runtime: { kind: 'wsl', distro } }
  }
  const msysRoot = process.env.TERMINATOR_MSYS_ROOT
  if (msysRoot && raw.startsWith('/') && !raw.startsWith('//')) {
    const drive = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(raw)
    if (drive) return { project: `${drive[1].toUpperCase()}:\\${(drive[2] ?? '').replace(/\//g, '\\')}` }
    return { project: join(msysRoot, raw) }
  }
  if (raw.startsWith('~') || raw.startsWith('\\\\') || raw.startsWith('//')) return { project: raw }
  if (process.platform === 'win32' && raw.startsWith('/')) return { project: raw }
  return { project: resolve(raw) }
}

function request_<C extends ControlCommand>(p: Parsed): ControlRequests[C] {
  const f = p.flags
  const str = (k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined)
  switch (p.cmd) {
    case 'list':
      return { protocol: PROTOCOL } as ControlRequests[C]
    case 'new': {
      const kind = p.pos[0]
      if (kind !== 'claude' && kind !== 'shell') throw new UsageError('new makes a claude or a shell session')
      const folder = str('project')
      if (!folder) throw new UsageError('new needs --project <folder>')
      const split = str('split')
      if (split !== undefined && !['left', 'right', 'up', 'down'].includes(split)) {
        throw new UsageError('--split takes left, right, up or down')
      }
      const req: ControlRequests['new'] = {
        protocol: PROTOCOL,
        kind,
        ...project(folder),
        ...(str('name') !== undefined ? { name: str('name') } : {}),
        ...(f.worktree ? { worktree: true } : {}),
        ...(str('branch') !== undefined ? { branch: str('branch') } : {}),
        ...(split ? { split: split as SplitSide } : {}),
      }
      return req as ControlRequests[C]
    }
    case 'send':
      return { protocol: PROTOCOL, session: p.pos[0], text: p.pos[1] } as ControlRequests[C]
    case 'wait': {
      const req: ControlRequests['wait'] = {
        protocol: PROTOCOL,
        session: p.pos[0],
        statuses: p.pos.slice(1).map((s) => s.toLowerCase() as StatusWord),
        ...(str('timeout') !== undefined ? { timeoutMs: duration(str('timeout')!) } : {}),
      }
      return req as ControlRequests[C]
    }
    case 'reply':
    case 'stop':
      return { protocol: PROTOCOL, session: p.pos[0] } as ControlRequests[C]
    case 'remove':
      return {
        protocol: PROTOCOL,
        session: p.pos[0],
        ...(f['remove-worktree'] ? { removeWorktree: true } : {}),
      } as ControlRequests[C]
  }
}

// ---- reaching the app -------------------------------------------------------------

/** Why the app can't be asked: scripting is off, or the app isn't running. */
function unreachable(home: string): string {
  try {
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { scripting?: unknown }
    if (settings.scripting !== true) {
      return 'scripting is off. Turn it on in Terminator, under Settings > SCRIPTING.'
    }
  } catch {
    // no settings yet: it has never been turned on
    return 'scripting is off. Turn it on in Terminator, under Settings > SCRIPTING.'
  }
  return "Terminator isn't running."
}

class Unreachable extends Error {}

function ask<C extends ControlCommand>(cmd: C, body: ControlRequests[C]): Promise<ControlResponse<C>> {
  const home = process.env.TERMINATOR_HOME
  if (!home) throw new Unreachable("TERMINATOR_HOME isn't set; run the terminator command Terminator installed")
  let ctl: ControlFile
  try {
    ctl = JSON.parse(readFileSync(join(home, 'control.json'), 'utf8')) as ControlFile
  } catch {
    throw new Unreachable(unreachable(home))
  }
  const data = Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: ctl.port,
        path: `/v1/${cmd}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          authorization: `Bearer ${ctl.token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            done(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ControlResponse<C>)
          } catch {
            fail(new Error(`Terminator answered with something that isn't JSON (HTTP ${res.statusCode})`))
          }
        })
        res.on('error', fail)
      },
    )
    req.on('error', (e: NodeJS.ErrnoException) => {
      // A control.json left behind by an app that's gone, or one switched off just now.
      if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') fail(new Unreachable(unreachable(home)))
      else fail(e)
    })
    req.end(data)
  })
}

// ---- output ----------------------------------------------------------------------

/** JSON with everything past ASCII escaped, so no console code page can garble it. */
function json(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function table(rows: ListedSession[]): string {
  const head = ['ID', 'NAME', 'KIND', 'PROJECT', 'BRANCH', 'STATUS']
  const cells = [head, ...rows.map((r) => [r.id, r.name, r.kind, r.project, r.branch, r.status])]
  const widths = head.map((_, i) => Math.max(...cells.map((c) => c[i].length)))
  return cells.map((c) => c.map((x, i) => (i === c.length - 1 ? x : x.padEnd(widths[i]))).join('  ')).join('\n')
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

function err(text: string): void {
  process.stderr.write(`terminator: ${text}\n`)
}

async function main(): Promise<number> {
  let p: Parsed | 'help'
  try {
    p = parse(process.argv.slice(2))
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    err(e.message)
    process.stderr.write(`\n${USAGE}\n`)
    return EXIT_FAIL
  }
  if (p === 'help') {
    out(USAGE)
    return EXIT_OK
  }
  const parsed = p

  let res: ControlResponse
  try {
    res = await ask(parsed.cmd, request_(parsed))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (parsed.json) out(json({ ok: false, error: msg }))
    else if (e instanceof UsageError) {
      err(msg)
      process.stderr.write(`\n${USAGE}\n`)
    } else err(msg)
    return EXIT_FAIL
  }

  if (parsed.json) {
    out(json(res))
    return res.ok ? EXIT_OK : res.timedOut ? EXIT_TIMEOUT : EXIT_FAIL
  }
  if (!res.ok) {
    // `new` made a session even though part of it failed: the id still comes out,
    // so the script can clean up after it.
    if (res.id) out(res.id)
    err(res.error)
    return res.timedOut ? EXIT_TIMEOUT : EXIT_FAIL
  }
  switch (parsed.cmd) {
    case 'list':
      out(table((res as ControlResponse<'list'> & { ok: true }).sessions))
      break
    case 'new':
      out((res as ControlResponse<'new'> & { ok: true }).id)
      break
    case 'wait': {
      const r = res as ControlResponse<'wait'> & { ok: true }
      if (r.warning) err(r.warning)
      out(r.status)
      break
    }
    case 'reply':
      out((res as ControlResponse<'reply'> & { ok: true }).markdown)
      break
  }
  return EXIT_OK
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    err(e instanceof Error ? e.message : String(e))
    process.exitCode = EXIT_FAIL
  },
)
