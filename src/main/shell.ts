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

/** Minimal POSIX shell quoting for values we interpolate into a command string. */
export function shquote(s: string): string {
  if (/^[A-Za-z0-9_/.:=,@%+-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}
