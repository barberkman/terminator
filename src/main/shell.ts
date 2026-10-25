import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { loginShell } from './shell-env'

/**
 * Resolve the default shell for new sessions. Single source of truth shared by
 * settings.ts (the stored default) and pty-manager.ts (the spawn-time fallback).
 *
 * - POSIX (Linux/macOS): the user's $SHELL, falling back to the account's shell.
 * - Windows: prefer PowerShell. Use PowerShell 7 (`pwsh.exe`) if it's on PATH,
 *   else Windows PowerShell (`powershell.exe`, present since Windows ≥ 5.1). We
 *   deliberately do NOT use COMSPEC, which always points at cmd.exe — a user who
 *   wants cmd can still set it explicitly in Settings.
 */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    return findOnPath('pwsh.exe') || 'powershell.exe'
  }
  return loginShell()
}

/** Shells that take `-l` for "login shell" alongside other flags (tcsh only takes it alone). */
const TAKES_LOGIN_FLAG = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'fish'])

/**
 * Whether a shell is started as a login shell here. Only on macOS, where every
 * terminal does it — Terminal.app, iTerm, VS Code — and where the profile files a
 * login shell reads are what put Homebrew and friends on PATH (see shell-env.ts).
 */
export function startsAsLogin(shell: string): boolean {
  return process.platform === 'darwin' && TAKES_LOGIN_FLAG.has(basename(shell))
}

/** The arguments a terminal pane's shell starts with: Settings' own, or the platform's default. */
export function shellArgsFor(shell: string, configured: string[]): string[] {
  if (configured.length) return configured
  return startsAsLogin(shell) ? ['-l'] : []
}

/** First absolute path for `name` found on PATH (Windows-only helper, no deps). */
function findOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH || '').split(';').filter(Boolean)
  for (const dir of dirs) {
    const full = join(dir, name)
    if (existsSync(full)) return full
  }
  return undefined
}

/**
 * Where a program named without a folder would be found, the way cmd.exe looks
 * it up: each PATH directory in turn, trying every PATHEXT extension when the
 * name has none. Not the bare name first — VS Code's `bin` folder holds a `code`
 * sh script for Git Bash right next to the `code.cmd` that Windows means.
 * Windows-only; undefined when nothing matches.
 */
export function findCommand(name: string): string | undefined {
  if (extname(name)) return findOnPath(name)
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of (process.env.PATH || '').split(';').filter(Boolean)) {
    for (const ext of exts) {
      const full = join(dir, name + ext.toLowerCase())
      if (existsSync(full)) return full
    }
  }
  return undefined
}

/** cmd.exe / PowerShell / POSIX shell argv to run a command string. */
export function shellRunArgs(shell: string, command: string, interactive = false): string[] {
  const base = shell.toLowerCase()
  if (process.platform === 'win32') {
    if (base.includes('powershell') || base.includes('pwsh')) {
      return ['-NoLogo', '-Command', command]
    }
    return ['/d', '/s', '/c', command]
  }
  // Interactive (-i) sources ~/.bashrc / ~/.zshrc, so the user's aliases and
  // functions (e.g. a `claude-readonly` alias) resolve. Login (-l) only sources
  // profile files, which usually don't define those. On macOS it's both: the
  // profile is where PATH is put together there (see startsAsLogin).
  if (interactive && startsAsLogin(shell)) return ['-l', '-i', '-c', command]
  return interactive ? ['-ic', command] : ['-lc', command]
}

/** Minimal POSIX shell quoting for values we interpolate into a command string. */
export function shquote(s: string): string {
  if (/^[A-Za-z0-9_/.:=,@%+-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Quote a value for the given shell. On Windows + PowerShell, single-quoted
 * strings are literal (no `$`/backtick expansion) and an embedded quote is escaped
 * by doubling it (`''`) — so a path like C:\Users\me\x.json is passed verbatim.
 * Everywhere else (POSIX shells, and the cmd.exe fallback) we use shquote.
 */
export function quoteFor(shell: string, s: string): string {
  if (process.platform === 'win32') {
    const base = shell.toLowerCase()
    if (base.includes('powershell') || base.includes('pwsh')) {
      return `'${s.replace(/'/g, `''`)}'`
    }
  }
  return shquote(s)
}
