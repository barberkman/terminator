// Where a session's process runs, and how its paths look from each side.
//
// A WSL session's process is Linux: its cwd, the paths it prints, the folder Claude
// files its transcript under and the worktrees git makes all speak Linux paths
// (/home/me/proj). So that is what a WSL session stores in `projectPath` and
// `worktreePath` — the same strings the session itself uses and the user types.
//
// This app is still a Windows process, though, and every file it reads for a WSL
// session goes through the distro's UNC share: \\wsl.localhost\<distro>\home\me\proj.
// `hostFolder` is that one mapping, and main and renderer both go through it so the
// two can never disagree about which string names a file.
//
// Pure string code on purpose (no `node:` imports): the renderer needs it too.

import type { FolderChoice, ProjectConfig, SessionRuntime } from './types'

/** Anything that may carry a runtime — a session, a project, a create request. */
interface HasRuntime {
  runtime?: SessionRuntime
}

export function isWsl(x?: HasRuntime | null): x is { runtime: SessionRuntime } {
  return x?.runtime?.kind === 'wsl' && !!x.runtime.distro
}

/** `'windows'` or `'wsl:<distro>'`, for maps and equality. */
export function runtimeKey(r?: SessionRuntime): string {
  return r?.kind === 'wsl' && r.distro ? `wsl:${r.distro.toLowerCase()}` : 'windows'
}

export function sameRuntime(a?: SessionRuntime, b?: SessionRuntime): boolean {
  return runtimeKey(a) === runtimeKey(b)
}

/**
 * A runtime read from somewhere untrusted (sessions.json, settings.json, IPC). Absent
 * or malformed means Windows — which is what every session was before this existed.
 */
export function validRuntime(v: unknown): SessionRuntime | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as { kind?: unknown; distro?: unknown }
  if (r.kind !== 'wsl' || typeof r.distro !== 'string') return undefined
  const distro = r.distro.trim()
  // Distro names are registry keys and folder names: no separators, no quotes.
  if (!distro || distro.length > 64 || /[\\/:*?"<>|\s]/.test(distro)) return undefined
  return { kind: 'wsl', distro }
}

/** Short label for chips and tooltips: `WSL` alone reads as noise when there is one distro. */
export function runtimeLabel(r?: SessionRuntime): string {
  return r?.kind === 'wsl' ? `WSL · ${r.distro}` : 'Windows'
}

// ---- Linux paths (posix rules, whatever the host) --------------------------

/** Collapse `.`, `..`, duplicate and trailing slashes. Absolute in, absolute out. */
export function posixNormalize(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(part)
  }
  const joined = out.join('/')
  return abs ? `/${joined}` : joined || '.'
}

/** `p` against `base` (both Linux); an absolute `p` wins. */
export function posixResolve(base: string, p: string): string {
  return posixNormalize(p.startsWith('/') ? p : `${base}/${p}`)
}

export function posixBasename(p: string): string {
  return posixNormalize(p).split('/').filter(Boolean).pop() ?? ''
}

/** True when `p` is `root` or somewhere under it. Both are normalised first. */
export function posixWithin(root: string, p: string): boolean {
  const r = posixNormalize(root)
  const x = posixNormalize(p)
  return x === r || x.startsWith(r === '/' ? '/' : `${r}/`)
}

/** Whether a user-typed folder is a Linux path rather than a Windows one. */
export function looksLinux(p: string): boolean {
  return p.startsWith('/') || p === '~' || p.startsWith('~/')
}

// ---- the distro's UNC share ------------------------------------------------

const UNC_RE = /^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i

/**
 * `\\wsl.localhost\Ubuntu\home\me` (or `\\wsl$\…`, or forward slashes) → its distro
 * and Linux path. Null for anything that isn't a WSL share.
 */
export function parseWslUnc(p: string): { distro: string; linux: string } | null {
  const m = UNC_RE.exec(p.trim())
  if (!m) return null
  const rest = (m[3] ?? '').replace(/\\/g, '/')
  return { distro: m[2], linux: posixNormalize(`/${rest}`) }
}

/** A Linux path in `distro`, as this (Windows) process reaches it. */
export function linuxToHost(distro: string, linux: string): string {
  const norm = posixNormalize(linux.startsWith('/') ? linux : `/${linux}`)
  return `\\\\wsl.localhost\\${distro}${norm === '/' ? '\\' : norm.replace(/\//g, '\\')}`
}

/**
 * A Windows-side path as `distro` sees it, or null when the distro can't reach it:
 *   • the distro's own share → its Linux path;
 *   • a drive path (`C:\x`) → `<mountRoot>c/x` (`/mnt/c/x` by default);
 *   • another distro's share, a network share → null.
 */
export function hostToLinux(distro: string, p: string, mountRoot = '/mnt/'): string | null {
  const unc = parseWslUnc(p)
  if (unc) return unc.distro.toLowerCase() === distro.toLowerCase() ? unc.linux : null
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(p.trim())
  if (!m) return null
  const root = mountRoot.endsWith('/') ? mountRoot : `${mountRoot}/`
  const rest = (m[2] ?? '').replace(/\\/g, '/')
  return posixNormalize(`${root}${m[1].toLowerCase()}/${rest}`)
}

// ---- a session's folders ---------------------------------------------------

interface HasFolders extends HasRuntime {
  projectPath: string
  worktreePath?: string
}

/** The folder as the session's own process sees it (Linux for WSL, Windows otherwise). */
export function sessionFolder(s: HasFolders, which: FolderChoice = 'session'): string {
  return which === 'project' ? s.projectPath : s.worktreePath || s.projectPath
}

/** The same folder as this process reaches it: the UNC share for WSL, as-is otherwise. */
export function hostFolder(s: HasFolders, which: FolderChoice = 'session'): string {
  const folder = sessionFolder(s, which)
  return isWsl(s) ? linuxToHost(s.runtime.distro, folder) : folder
}

// ---- grouping --------------------------------------------------------------

/**
 * What the sidebar groups sessions by. A Windows session's key is its project name,
 * exactly as it always was; a WSL session's is prefixed with its distro, so a WSL
 * `api` and a Windows `api` are two groups rather than one.
 */
export function groupKey(s: HasRuntime & { projectName: string }): string {
  return isWsl(s) ? `${runtimeKey(s.runtime)}|${s.projectName}` : s.projectName
}

/** The remembered project at `path` in `runtime` — the same path in two distros is two projects. */
export function findProject(
  list: ProjectConfig[],
  path: string,
  runtime?: SessionRuntime,
): ProjectConfig | undefined {
  return list.find((p) => p.path === path && sameRuntime(p.runtime, runtime))
}
