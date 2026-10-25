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
//
// A clicked *file path* gets the same treatment: the token is re-resolved against
// its own session's folder here, so a path on screen can only ever open something
// that session could already reach — or a PDF, which opens in a pane wherever it
// is — and the editor is launched with the file as its own argv element.

import { execFile, spawn, type SpawnOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { webUrl } from '../shared/url'
import { programName } from '../shared/editor-name'
import { existsSync, promises as fsp, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { shell } from 'electron'
import {
  IN_APP_BROWSER_ID,
  type BrowserOption,
  type OpenFileInput,
  type OpenFileResult,
  type OpenLinkResult,
} from '../shared/types'
import { isWsl, linuxToHost, posixResolve, posixWithin, sessionFolder } from '../shared/wsl-path'
import { loadSettings } from './settings'
import { expandHome } from './pty-manager'
import { getSession } from './state'
import { expandLinuxHome, probe } from './wsl'
import { whenShellEnv } from './shell-env'

const pExecFile = promisify(execFile)

/** Same idea as MAX_URL_LENGTH, for a path-like token out of the scrollback. */
const MAX_PATH_LENGTH = 1024
/** The one kind of file a printed path may reach outside its session's folder: a PDF pane shows any. */
const PDF_RE = /\.pdf$/i

// The rule itself moved to shared/url.ts once the in-app browser needed to run it
// without going through this process. Re-exported here because this file's
// guarantees are the ones written down, and its callers shouldn't have to care.
export { webUrl } from '../shared/url'

/**
 * Spawn detached, and wait just long enough to learn whether it started. Resolves
 * null on success, the reason otherwise. Exported because opening an attachment
 * launches the same configured editor the same way — no shell, one argv element
 * per argument — and that guarantee is worth stating in one place only.
 *
 * `opts` exists for the one caller that has to go through cmd.exe on Windows (see
 * `launchEditor` in worktree.ts) and quotes the command line itself.
 */
export async function launchDetached(
  exe: string,
  args: string[],
  opts: Pick<SpawnOptions, 'windowsHide' | 'windowsVerbatimArguments'> = {},
): Promise<string | null> {
  // A bare command name is looked up on PATH, which on macOS has to be the login
  // shell's before it can find anything (see shell-env.ts).
  await whenShellEnv()
  const app = await macApp(exe, args)
  if ('error' in app) return app.error
  if (app.exe === '/usr/bin/open' || (process.platform === 'darwin' && exe === 'open')) {
    return runOpen(app.exe, app.args)
  }
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(app.exe, app.args, { ...opts, detached: true, stdio: 'ignore', shell: false })
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

/**
 * What to run for a program that is a macOS app bundle — which is what the file
 * picker in Settings hands back for anything in /Applications. A bundle is a
 * folder, so it can't be spawned as it is:
 *
 *   • With nothing but a URL or a file to hand it, it goes through `open -a`, so
 *     Launch Services delivers it to the copy already running, as clicking a link
 *     elsewhere would.
 *   • With flags (`--incognito`, `-g {path}:{line}`), `open` would only pass them
 *     on to a copy it starts fresh, so the bundle's own executable is run instead,
 *     the way its command-line launcher would.
 *
 * Anything else, and every other platform, is run as it is.
 */
async function macApp(exe: string, args: string[]): Promise<{ exe: string; args: string[] } | { error: string }> {
  const bundle = exe.replace(/\/+$/, '')
  if (process.platform !== 'darwin' || !/\.app$/i.test(bundle)) return { exe, args }
  if (!existsSync(bundle)) return { error: `there's no app at ${bundle}` }
  const documents = args.every((a) => webUrl(a) || (isAbsolute(a) && existsSync(a)))
  if (documents) return { exe: '/usr/bin/open', args: ['-a', bundle, ...args] }
  try {
    const plist = join(bundle, 'Contents', 'Info.plist')
    const { stdout } = await pExecFile('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist])
    const program = join(bundle, 'Contents', 'MacOS', basename(stdout.trim()))
    if (!stdout.trim() || !existsSync(program)) return { error: `${basename(bundle)} has no program to run` }
    return { exe: program, args }
  } catch {
    return { error: `${basename(bundle)} doesn't look like an app` }
  }
}

/**
 * `open` hands the launch to Launch Services and exits, with an error when there
 * was nothing to open — so unlike a program spawned directly, it's worth waiting
 * for: otherwise an app that isn't installed would be reported as opened.
 */
function runOpen(exe: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false })
    } catch (e) {
      done(String(e).slice(0, 160))
      return
    }
    let err = ''
    child.stderr?.on('data', (d) => (err += d))
    const timer = setTimeout(() => done(null), 10_000)
    child.once('error', (e) => {
      clearTimeout(timer)
      done(e.message || String(e))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      done(code ? err.trim().split('\n')[0] || `open exited with ${code}` : null)
    })
  })
}

/**
 * `undefined` means "whatever the default is"; `''` means "no configured browser,
 * whatever the default is" — which is what the right-click menu's *Open in system
 * default* asks for, and it only works if the two are told apart before the falsy
 * check. Anything else is a browser id, and an unknown one falls through to the OS
 * handler rather than failing.
 */
function findBrowser(id: string | undefined): BrowserOption | undefined {
  const { links } = loadSettings()
  const wanted = id === undefined ? links.defaultBrowserId : id
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

  // The in-app browser is a pane, not a program. Opening one is the renderer's job
  // and it never calls here for it, so arriving with that id means the renderer took
  // the wrong fork — and falling through to `shell.openExternal` would bury that in
  // a link that quietly opened in the wrong place.
  const wanted = browserId === undefined ? loadSettings().links.defaultBrowserId : browserId
  if (wanted === IN_APP_BROWSER_ID) {
    return { ok: false, reason: 'the in-app browser opens in a pane, not through here' }
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
  const error = await launchDetached(exe, [...browser.args, url])
  if (error) return { ok: false, reason: `${browser.name} wouldn't start: ${error.slice(0, 140)}` }
  return { ok: true, browser: browser.name }
}

/**
 * Resolve a path-like token a session printed to a real file.
 *
 * Relative tokens are resolved against the session's own folder, and the result
 * has to stay inside it — the same boundary the editor's filesystem service
 * enforces, so a path in output can't reach anything the session couldn't. A PDF
 * is the exception: a PDF pane opens one from anywhere, so a `.pdf` path may
 * resolve outside the folder. Null for anything else that isn't an existing file
 * inside that folder.
 */
export async function resolveOutputPath(sessionId: string, token: string): Promise<string | null> {
  const session = getSession(sessionId)
  if (!session) return null
  const raw = token.trim()
  if (!raw || raw.length > MAX_PATH_LENGTH) return null

  // A WSL session prints Linux paths, so they are resolved by Linux rules against its
  // Linux folder — `~` being the distro user's home — and only then mapped to the
  // share this process reads through. The containment check is done on the Linux
  // side, where the session's own idea of "inside" lives.
  if (isWsl(session)) {
    const root = sessionFolder(session)
    let linux = raw
    if (raw === '~' || raw.startsWith('~/')) {
      const p = await probe(session.runtime.distro)
      if (!p.ok) return null
      linux = expandLinuxHome(p, raw)
    }
    linux = posixResolve(root, linux)
    if (!posixWithin(root, linux) && !PDF_RE.test(linux)) return null
    const host = linuxToHost(session.runtime.distro, linux)
    try {
      return (await fsp.stat(host)).isFile() ? host : null
    } catch {
      return null
    }
  }

  const root = resolve(expandHome(session.worktreePath || session.projectPath) || session.projectPath)
  const expanded = expandHome(raw) || raw
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded)
  if (!within(root, abs) && !withinReal(root, abs) && !PDF_RE.test(abs)) return null

  try {
    return statSync(abs).isFile() ? abs : null
  } catch {
    return null
  }
}

function within(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * The same test on the real paths, off Windows: Claude prints the folder it runs
 * in as its process.cwd() names it, so a project opened as `/tmp/x` shows up in its
 * output as `/private/tmp/x/…`, and one typed in the wrong case in its real case.
 */
function withinReal(root: string, p: string): boolean {
  if (process.platform === 'win32') return false
  try {
    return within(realpathSync.native(root), realpathSync.native(p))
  } catch {
    return false
  }
}

/** A configured editor's display name: the executable's basename, no extension. */
export function editorName(command: string, args?: string[]): string {
  return programName(command, args) || 'your editor'
}

/**
 * Build the editor's argv. `{path}`, `{line}` and `{column}` are substituted
 * wherever they appear; an argument that mentions `{line}` (or `{column}`) is
 * dropped when there is no line number, so `-n{line}` doesn't become a bare
 * `-n`; and with no `{path}` anywhere the file is appended last, which is what
 * an editor invoked as `editor <file>` wants.
 */
export function editorArgv(args: string[], path: string, line?: number, column?: number): string[] {
  const out: string[] = []
  let placed = false
  for (const arg of args) {
    if (line === undefined && /\{(line|column)\}/.test(arg)) continue
    if (arg.includes('{path}')) placed = true
    out.push(
      arg
        .replaceAll('{path}', path)
        .replaceAll('{line}', String(line ?? ''))
        .replaceAll('{column}', String(column ?? 1)),
    )
  }
  if (!placed) out.push(path)
  return out
}

/**
 * Open a file a session printed, in the user's configured editor. The path is
 * re-resolved through `resolveOutputPath` rather than trusted: the renderer saw
 * it in someone else's program's output, which is a suggestion, not permission.
 */
export async function openInEditor(input: OpenFileInput): Promise<OpenFileResult> {
  const abs = await resolveOutputPath(input.sessionId, input.path)
  if (!abs) {
    return { ok: false, reason: "that file isn't inside the session's folder any more" }
  }
  const { editor } = loadSettings().links
  const command = editor?.command?.trim()
  if (!command) return { ok: false, reason: 'no external editor is set in Settings' }

  const exe = expandHome(command) || command
  const name = editorName(command, editor.args)
  const error = await launchDetached(
    exe,
    editorArgv(editor.args ?? [], abs, input.line, input.column),
  )
  if (error) return { ok: false, reason: `${name} wouldn't start: ${error.slice(0, 140)}` }
  return { ok: true, editor: name }
}
