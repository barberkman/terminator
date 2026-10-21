// The door the `terminator` command knocks on (see scripting.ts for what it does).
//
// The same shape as the hook report server — loopback HTTP, a random port, a bearer
// token — but its own server with its own token, for two reasons. The report token
// is handed to every Claude session and written into its settings file, and this
// one controls the whole app: whatever can read a session's environment must not
// be able to drive the others. And this one only exists while Settings →
// SCRIPTING is on, where the report server always has to be listening.
//
// Who gets in is "your user account, on this machine, and nothing else":
//   • loopback only — no other machine can connect at all;
//   • the token lives in control.json in your user-data folder, readable by you
//     alone (your profile's ACL on Windows, mode 600 elsewhere) — another local user
//     can reach the port but has nothing to show it;
//   • a request carrying an Origin header comes from a web page, and a Host other
//     than our own address is a rebound DNS name; both are turned away before the
//     token is even looked at.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ControlFile, ControlProtocol, ControlResponse } from '../shared/control'
import { isCommand, runCommand } from './scripting'
import { loadSettings } from './settings'

const PROTOCOL: ControlProtocol = 1
/** A prompt is capped at 100,000 characters (send-prompt.ts); this is that, UTF-8 and escaped, with room. */
const MAX_BODY_BYTES = 1024 * 1024

let server: Server | null = null
let port = 0
let token = ''
/** Requests still being answered — a `wait` can be open for hours. */
const open = new Set<AbortController>()

function controlFile(): string {
  return join(app.getPath('userData'), 'control.json')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function reply(res: ServerResponse, code: number, body: ControlResponse | { ok: false; error: string }): void {
  if (res.writableEnded || res.destroyed) return
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}`) {
    reply(res, 403, { ok: false, error: 'not from here' })
    return
  }
  if (!safeEqual(String(req.headers['authorization'] ?? ''), 'Bearer ' + token)) {
    reply(res, 401, { ok: false, error: "that isn't this app's scripting token — is another Terminator running?" })
    return
  }
  if (req.method !== 'POST') {
    reply(res, 405, { ok: false, error: 'POST only' })
    return
  }
  const name = /^\/v1\/([a-z]+)$/.exec(req.url ?? '')?.[1] ?? ''
  if (!isCommand(name)) {
    reply(res, 404, { ok: false, error: `there's no ${name || 'such'} command` })
    return
  }

  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > MAX_BODY_BYTES) {
      reply(res, 413, { ok: false, error: 'that request is too large' })
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (res.writableEnded) return
    let body: Record<string, unknown>
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
    } catch {
      reply(res, 400, { ok: false, error: "that request isn't JSON" })
      return
    }
    if (body.protocol !== PROTOCOL) {
      reply(res, 409, {
        ok: false,
        error: 'this terminator command belongs to a different version of Terminator — run the one the app installed',
      })
      return
    }
    // A request whose caller has gone — Ctrl+C on a long `wait` — stops waiting.
    // `close` on the response, not the request: the request closes as soon as its
    // body has been read, which is now.
    const ac = new AbortController()
    open.add(ac)
    res.on('close', () => {
      if (!res.writableFinished) ac.abort()
    })
    void runCommand(name, body as never, ac.signal)
      .then((out) => reply(res, 200, out))
      .finally(() => open.delete(ac))
  })
}

function writeControlFile(): void {
  const file = controlFile()
  mkdirSync(app.getPath('userData'), { recursive: true })
  const data: ControlFile = { port, token, pid: process.pid, protocol: PROTOCOL }
  // Written whole and then moved into place, so the mode is set on a file nobody
  // could have opened yet and a reader never sees half of one.
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Take control.json away — but only ours. A dev build and the installed one can
 * run side by side on one user-data folder, and the one quitting must not strand
 * the other's command.
 */
function removeControlFile(): void {
  const file = controlFile()
  try {
    const cur = JSON.parse(readFileSync(file, 'utf8')) as Partial<ControlFile>
    if (cur.pid === process.pid) rmSync(file, { force: true })
  } catch {
    // not there, or not ours to read
  }
}

function start(): void {
  token = randomBytes(24).toString('hex')
  const s = createServer(handle)
  server = s
  s.listen(0, '127.0.0.1', () => {
    if (server !== s) return
    const addr = s.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
    writeControlFile()
  })
}

function stop(): void {
  const s = server
  if (!s) return
  server = null
  removeControlFile()
  // Anything still waiting is answered ("cancelled") rather than cut off.
  for (const ac of open) ac.abort()
  s.close()
  s.closeIdleConnections()
}

/** Start or stop listening to match Settings → SCRIPTING. Called at boot and on every settings save. */
export function applyScripting(): void {
  const on = !!loadSettings().scripting
  if (on && !server) start()
  else if (!on && server) stop()
}

export function stopControlServer(): void {
  stop()
}
