// Opening something a terminal printed.
//
// Terminal output is untrusted input: a URL on screen is whatever the program
// on the other end decided to write. So the renderer is never the last word on
// what gets launched — every request is re-validated here, and only then does
// anything start:
//
//   • http/https only. Every other scheme (file:, javascript:, custom handlers)
//     is refused, so output can't reach anything but a browser.
//   • The URL is passed as one argv element to spawn() with no shell anywhere in
//     the chain, so quoting, redirection and word-splitting have no meaning.
//   • The browser is the user's configured executable path, never a command line
//     to be re-split — which is what makes C:\Program Files\… work untouched.

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { shell } from 'electron'
import type { BrowserOption, OpenLinkResult } from '../shared/types'
import { loadSettings } from './settings'
import { expandHome } from './pty-manager'
import { getSession } from './state'

/** Long enough for any real link, short enough that nothing silly gets launched. */
const MAX_URL_LENGTH = 2048
/** Same idea for a path-like token out of the scrollback. */
const MAX_PATH_LENGTH = 1024

/**
 * The only URLs this app will open. Returns the normalised form to launch with,
 * or null — callers must treat null as "refuse", never as "pass it through".
 */
export function webUrl(raw: string): string | null {
  if (!raw || raw.length > MAX_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.toString()
}

/** Spawn detached, and wait just long enough to learn whether it started. */
function launch(exe: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, { detached: true, stdio: 'ignore', shell: false })
    } catch (e) {
      done(String(e).slice(0, 160))
      return
    }
    child.once('error', (e) => done(e.message || String(e)))
    child.once('spawn', () => {
      // Unref so quitting Terminator never takes the browser with it.
      child.unref()
      done(null)
    })
  })
}

function findBrowser(id: string | undefined): BrowserOption | undefined {
  const { links } = loadSettings()
  const wanted = id || links.defaultBrowserId
  if (!wanted) return undefined
  return links.browsers.find((b) => b.id === wanted)
}

/**
 * Open a link from terminal output. With no browser configured (or none matching
 * the requested id) it falls back to the OS handler — still only ever for a URL
 * that passed `webUrl`.
 */
export async function openLink(raw: string, browserId?: string): Promise<OpenLinkResult> {
  const url = webUrl(raw)
  if (!url) {
    return { ok: false, reason: 'only http and https links can be opened from terminal output' }
  }

  const browser = findBrowser(browserId)
  if (!browser || !browser.command.trim()) {
    try {
      await shell.openExternal(url)
      return { ok: true, browser: 'your default browser' }
    } catch (e) {
      return { ok: false, reason: `the system browser refused it: ${String(e).slice(0, 120)}` }
    }
  }

  const exe = expandHome(browser.command.trim()) || browser.command.trim()
  const error = await launch(exe, [...browser.args, url])
  if (error) return { ok: false, reason: `${browser.name} wouldn't start: ${error.slice(0, 140)}` }
  return { ok: true, browser: browser.name }
}

/**
 * Resolve a path-like token a session printed to a real file.
 *
 * Relative tokens are resolved against the session's own folder, and the result
 * has to stay inside it — the same boundary the editor's filesystem service
 * enforces, so a path in output can't reach anything the session couldn't.
 * Null for anything that isn't an existing file inside that folder.
 */
export function resolveOutputPath(sessionId: string, token: string): string | null {
  const session = getSession(sessionId)
  if (!session) return null
  const raw = token.trim()
  if (!raw || raw.length > MAX_PATH_LENGTH) return null

  const root = resolve(expandHome(session.worktreePath || session.projectPath) || session.projectPath)
  const expanded = expandHome(raw) || raw
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded)
  if (abs !== root && !abs.startsWith(root.endsWith(sep) ? root : root + sep)) return null

  try {
    return statSync(abs).isFile() ? abs : null
  } catch {
    return null
  }
}
