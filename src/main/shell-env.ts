import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { app } from 'electron'

// macOS starts an app from the Dock or Finder with launchd's environment, not a
// shell's: PATH is /usr/bin:/bin:/usr/sbin:/sbin and there is no LANG. Everything a
// person adds in ~/.zprofile or ~/.zshrc — Homebrew, nvm, ~/.local/bin, and with
// them `claude`, `code`, a git GUI's command — is missing from it. A terminal never
// shows this, because it starts a login shell that builds PATH from scratch.
//
// So, on macOS only:
//
//   • Terminal panes are login shells, the way Terminal.app's are, and are given the
//     environment the app started with (`originalEnv`). Their rc files then build
//     PATH once, rather than on top of a PATH they already built — which would
//     double every entry and let path_helper reorder them.
//   • Everything else the main process starts — a browser, an editor, the git
//     tool, the notification command — gets the environment a login shell ends up
//     with. That is read once at startup (`startShellEnv`), off the critical path:
//     the window doesn't wait for it, and only the launches that need a PATH do
//     (`whenShellEnv`), for at most RESOLVE_TIMEOUT_MS.
//
// Elsewhere none of this runs: Windows has no such split, and a Linux desktop
// session already carries the login environment.

/** process.env as the app was started, before anything was merged into it. */
const original: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) original[k] = v

/** A terminal's own variables. They describe the terminal the app was started from, not the app. */
const TERMINAL_IDENTITY = /^(TERM_PROGRAM(_VERSION)?|TERM_SESSION_ID|ITERM_.*|LC_TERMINAL(_VERSION)?|VSCODE_.*)$/

/** What a resolved environment never overrides: per-process shell state, and the above. */
const NOT_MERGED = /^(_|PWD|OLDPWD|SHLVL|TERM|COLORTERM|ELECTRON_RUN_AS_NODE|TERMINATOR_RESOLVING_ENVIRONMENT)$/

const RESOLVE_TIMEOUT_MS = 10_000
const MARK = '__TERMINATOR_ENV_7f3a__'

let resolved: Promise<void> = Promise.resolve()

/** The environment the app was started with, minus the launching terminal's identity. */
export function originalEnv(): Record<string, string> {
  return withoutTerminalIdentity(original)
}

export function withoutTerminalIdentity(env: Record<string, string>): Record<string, string> {
  if (process.platform !== 'darwin') return env
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (!TERMINAL_IDENTITY.test(k)) out[k] = v
  return out
}

/** The user's login shell. Finder passes $SHELL on; the account record is the fallback. */
export function loginShell(): string {
  if (process.env.SHELL) return process.env.SHELL
  if (process.platform !== 'darwin') return '/bin/bash'
  try {
    if (userInfo().shell) return userInfo().shell as string
  } catch {
    // no account record — fall through
  }
  return '/bin/zsh'
}

/**
 * Read a login shell's environment into process.env. Called once, before the
 * window opens; returns at once and does its work in the background.
 */
export function startShellEnv(): void {
  if (process.platform !== 'darwin') return
  resolved = resolveLoginEnv().then(
    (env) => merge(env),
    (e) => {
      console.error('[terminator] could not read the login shell environment:', e instanceof Error ? e.message : e)
      fallbackPath()
    },
  )
}

/** Resolves once process.env holds the login environment (or the attempt gave up). */
export function whenShellEnv(): Promise<void> {
  return resolved
}

function resolveLoginEnv(): Promise<Record<string, string>> {
  return new Promise((done, fail) => {
    // `env -0` because a value may hold a newline; the markers because rc files
    // are free to print whatever they like before and after it.
    const script = `echo ${MARK}; /usr/bin/env -0; echo ${MARK}`
    const child = spawn(loginShell(), ['-i', '-l', '-c', script], {
      cwd: homedir(),
      // Its own process group, so a timeout takes down whatever the rc files started.
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      // An rc file can test for this and skip anything slow or interactive.
      env: { ...originalEnv(), TERMINATOR_RESOLVING_ENVIRONMENT: '1' },
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // already gone
      }
      fail(new Error(`no answer after ${RESOLVE_TIMEOUT_MS / 1000} s`))
    }, RESOLVE_TIMEOUT_MS)
    child.on('error', (e) => {
      clearTimeout(timer)
      fail(e)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const text = Buffer.concat(chunks).toString('utf8')
      const start = text.indexOf(MARK)
      const end = text.lastIndexOf(MARK)
      if (start < 0 || end <= start) {
        fail(new Error('the shell printed no environment'))
        return
      }
      const env: Record<string, string> = {}
      for (const entry of text.slice(start + MARK.length, end).split('\0')) {
        const line = entry.replace(/^\n/, '')
        const eq = line.indexOf('=')
        if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
      }
      if (!env.PATH) fail(new Error('the shell printed no PATH'))
      else done(env)
    })
  })
}

function merge(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (NOT_MERGED.test(k) || TERMINAL_IDENTITY.test(k)) continue
    process.env[k] = v
  }
}

/** No shell answered: at least reach the places programs are usually installed. */
function fallbackPath(): void {
  const have = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const add = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/opt/local/bin',
    join(homedir(), '.local', 'bin'),
  ].filter((d) => !have.includes(d) && existsSync(d))
  process.env.PATH = [...add, ...have].join(delimiter)
}

let lang: string | undefined

/**
 * A UTF-8 LANG for a terminal, from the system's region settings: what
 * Terminal.app sets for its shells. Without one zsh treats every non-ASCII
 * character as raw bytes, so ç or ş at the prompt prints as an escape code.
 */
export function terminalLang(): string {
  if (lang) return lang
  const [language, region] = app.getSystemLocale().split(/[-_]/)
  const candidate = language && region ? `${language.toLowerCase()}_${region.toUpperCase()}.UTF-8` : ''
  lang = candidate && existsSync(join('/usr/share/locale', candidate)) ? candidate : 'en_US.UTF-8'
  return lang
}
