import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Resolve the default shell for new sessions. Single source of truth shared by
 * settings.ts (the stored default) and pty-manager.ts (the spawn-time fallback).
 *
 * - POSIX (Linux/macOS): the user's $SHELL, falling back to /bin/bash.
 * - Windows: prefer PowerShell. Use PowerShell 7 (`pwsh.exe`) if it's on PATH,
 *   else Windows PowerShell (`powershell.exe`, present since Windows ≥ 5.1). We
 *   deliberately do NOT use COMSPEC, which always points at cmd.exe — a user who
 *   wants cmd can still set it explicitly in Settings.
 */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    return findOnPath('pwsh.exe') || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/bash'
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
  // profile files, which usually don't define those.
  return interactive ? ['-ic', command] : ['-lc', command]
}

/**
 * Like shellRunArgs, but the shell stays open at an interactive prompt after the
 * command finishes (Build/Run panes), using each shell's native idiom:
 * PowerShell `-NoExit`, cmd `/k`, and POSIX `<cmd>; exec <shell>`. POSIX runs the
 * command interactively first (so aliases resolve), then execs a fresh interactive
 * shell so the pane stays usable — even if the command failed.
 */
export function shellKeepOpenArgs(shell: string, command: string): string[] {
  const base = shell.toLowerCase()
  if (process.platform === 'win32') {
    if (base.includes('powershell') || base.includes('pwsh')) {
      return ['-NoLogo', '-NoExit', '-Command', command]
    }
    return ['/k', command]
  }
  return ['-ic', `${command}; exec ${shquote(shell)}`]
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
