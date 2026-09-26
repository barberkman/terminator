// Talking to WSL from the Windows side.
//
// Everything that has to run *inside* a distro — listing and probing it, git for a
// WSL project, finding a leftover process, writing the Ctrl+G shim — goes through
// `wsl.exe` here, and nowhere else. Three rules hold for every call:
//
//   • The absolute System32 wsl.exe, with `windowsHide`: Electron's main process is a
//     GUI app, and a console program started from one flashes a window otherwise.
//   • `WSL_UTF8=1`, so wsl.exe's own messages come back as UTF-8 rather than UTF-16.
//     Older builds ignore it, which `decode` catches.
//   • Arguments stay simple (paths, names — never a quote). node spawns a Windows
//     command line and wsl.exe parses it back, and a script's quoting would not
//     survive that round trip intact. Scripts go on stdin to `sh -s` instead.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { CreateSessionInput, SessionRuntime, WslDistro, WslProbe } from '../shared/types'
import { hostToLinux, looksLinux, parseWslUnc, posixNormalize } from '../shared/wsl-path'
import { shquote } from './shell'

export function wslExe(): string {
  return join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'wsl.exe')
}

/** wsl.exe's own output: UTF-8 when it honoured WSL_UTF8, UTF-16LE when it didn't. */
function decode(buf: Buffer): string {
  const text = buf.length >= 2 && buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8')
  return text.replace(/^\uFEFF/, '')
}

interface RunResult {
  code: number
  /** A Linux program's output: UTF-8. */
  stdout: string
  /** The same bytes undecoded — wsl.exe's *own* output needs `decode` instead. */
  raw: Buffer
  stderr: string
}

/** Run wsl.exe with `args`, optionally feeding `input` on stdin. Never rejects. */
function run(args: string[], o: { input?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(wslExe(), args, {
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      done({ code: -1, stdout: '', raw: Buffer.alloc(0), stderr: String(e) })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }, o.timeoutMs ?? 15_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ code: -1, stdout: '', raw: Buffer.alloc(0), stderr: e.message || String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const raw = Buffer.concat(out)
      done({
        code: code ?? -1,
        stdout: raw.toString('utf8'),
        raw,
        stderr: decode(Buffer.concat(err)).trim(),
      })
    })
    child.stdin?.on('error', () => {
      // the process may exit before reading everything; its exit code says enough
    })
    child.stdin?.end(o.input ?? '')
  })
}

/**
 * Run `argv` inside `distro`, in `cwd` (a Linux path), with no shell in between.
 * Resolves with the exit code; `wslCheck` is the throwing form.
 */
export function wslExec(
  distro: string,
  cwd: string,
  argv: string[],
  o: { input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return run(['-d', distro, '--cd', cwd, '--exec', ...argv], o)
}

/** `wslExec`, throwing the command's own complaint when it fails. */
export async function wslCheck(
  distro: string,
  cwd: string,
  argv: string[],
  o: { input?: string; timeoutMs?: number } = {},
): Promise<string> {
  const r = await wslExec(distro, cwd, argv, o)
  if (r.code !== 0) throw new Error(r.stderr || r.stdout.trim() || `exited with ${r.code}`)
  return r.stdout
}

// ---- distros -----------------------------------------------------------------

/** Docker Desktop's utility distros aren't anywhere a person works. */
const HIDDEN_DISTROS = /^docker-desktop(-data)?$/i

let distroCache: { at: number; list: WslDistro[] } | null = null
const DISTRO_TTL_MS = 10_000

/**
 * Installed distros, from `wsl -l -v`. Parsed by shape — an optional `*`, a name,
 * a state, a version number — rather than by the header, which is localised. Never
 * boots a distro. Empty when WSL isn't installed.
 */
export async function listDistros(force = false): Promise<WslDistro[]> {
  if (process.platform !== 'win32') return []
  if (!force && distroCache && Date.now() - distroCache.at < DISTRO_TTL_MS) return distroCache.list
  const r = await run(['-l', '-v'], { timeoutMs: 10_000 })
  const list: WslDistro[] = []
  if (r.code === 0) {
    // stdout here is wsl.exe's own, so it gets the same decoding as stderr.
    for (const line of decode(r.raw).split(/\r?\n/)) {
      const m = /^\s*(\*)?\s*(\S+)\s+(.+?)\s+(\d+)\s*$/.exec(line)
      if (!m || HIDDEN_DISTROS.test(m[2])) continue
      list.push({ name: m[2], isDefault: !!m[1], version: Number(m[4]), state: m[3].trim() })
    }
  }
  distroCache = { at: Date.now(), list }
  return list
}

/** The registered spelling of a distro name typed in any case, or null if none matches. */
export async function canonicalDistro(name: string): Promise<string | null> {
  const want = name.toLowerCase()
  const hit = (await listDistros()).find((d) => d.name.toLowerCase() === want)
  if (hit) return hit.name
  // A distro installed a moment ago isn't in a cached list yet.
  const fresh = (await listDistros(true)).find((d) => d.name.toLowerCase() === want)
  return fresh?.name ?? null
}

// ---- probing -----------------------------------------------------------------

/** A probe plus what only main needs from it. */
export interface Probe extends WslProbe {
  /** Shell a Claude session runs its command through (sh-compatible, login + interactive). */
  launchShell: string
  /** This app's executable as the distro names it, e.g. `/mnt/c/…/Terminator.exe`. */
  exeLinux: string
}

const probes = new Map<string, Probe>()
const inflight = new Map<string, Promise<Probe>>()

/**
 * The probe script. Everything is printed as `__T_key=value` lines, so whatever a
 * login shell's rc files print around it doesn't matter. The login-interactive shell
 * runs last and with stdin from /dev/null: an rc file that reads stdin would
 * otherwise swallow the rest of this script, which is itself arriving on stdin.
 */
function probeScript(): string {
  return [
    'u=$(id -un)',
    'pw=$(getent passwd "$u")',
    'home=$(printf %s "$pw" | cut -d: -f6); [ -n "$home" ] || home=$HOME',
    'lsh=$(printf %s "$pw" | cut -d: -f7); [ -x "$lsh" ] || lsh=/bin/sh',
    'printf "__T_user=%s\\n" "$u"',
    'printf "__T_home=%s\\n" "$home"',
    'printf "__T_shell=%s\\n" "$lsh"',
    `printf "__T_mount=%s\\n" "$(wslpath -u ${shquote('C:\\')} 2>/dev/null)"`,
    'printf "__T_net=%s\\n" "$(wslinfo --networking-mode 2>/dev/null)"',
    'if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ]; then printf "__T_interop=1\\n"; else printf "__T_interop=0\\n"; fi',
    `exe=$(wslpath -u ${shquote(process.execPath)} 2>/dev/null)`,
    'printf "__T_exepath=%s\\n" "$exe"',
    'if [ -n "$exe" ] && [ -x "$exe" ]; then printf "__T_exe=1\\n"; else printf "__T_exe=0\\n"; fi',
    'printf "__T_git=%s\\n" "$(git --version 2>/dev/null)"',
    // Claude sessions run through a shell that understands POSIX quoting: the login
    // shell when it does, otherwise bash (or sh). fish and friends don't.
    'case "${lsh##*/}" in bash|zsh|sh|dash|ksh|mksh|ash) run=$lsh ;; *) if [ -x /bin/bash ]; then run=/bin/bash; else run=/bin/sh; fi ;; esac',
    'printf "__T_launch=%s\\n" "$run"',
    // The rest needs the user's real environment: PATH from rc files (where a native
    // `claude` install lives) and any CLAUDE_CONFIG_DIR. The config dir is resolved,
    // because Windows can't follow a Linux symlink over the UNC share.
    `"$run" -lic ${shquote(
      'printf "__T_claude=%s\\n" "$(command -v claude 2>/dev/null)"; d="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; printf "__T_cfg=%s\\n" "$(readlink -f "$d" 2>/dev/null || printf %s "$d")"',
    )} </dev/null 2>/dev/null`,
    'exit 0',
  ].join('\n')
}

function failed(distro: string, reason: string): Probe {
  return {
    distro,
    ok: false,
    reason,
    user: '',
    home: '',
    shell: '',
    mountRoot: '/mnt/',
    networking: '',
    interop: false,
    exeReachable: false,
    claudePath: '',
    claudeDir: '',
    gitVersion: '',
    launchShell: '/bin/sh',
    exeLinux: '',
  }
}

async function runProbe(distro: string): Promise<Probe> {
  if (process.platform !== 'win32') return failed(distro, 'WSL is only available on Windows')
  const name = await canonicalDistro(distro)
  if (!name) return failed(distro, `there is no WSL distro called "${distro}"`)
  // Generous: the first call after the VM idled out boots the distro first.
  const r = await run(['-d', name, '--cd', '/', '--exec', 'sh', '-s'], {
    input: probeScript(),
    timeoutMs: 30_000,
  })
  const kv = new Map<string, string>()
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^__T_(\w+)=(.*)$/.exec(line)
    if (m) kv.set(m[1], m[2].trim())
  }
  const home = kv.get('home') ?? ''
  if (!home) {
    const why = r.stderr || r.stdout.trim() || `wsl.exe exited with ${r.code}`
    return failed(name, `couldn't reach ${name}: ${why.slice(0, 200)}`)
  }
  const mount = kv.get('mount') ?? ''
  // `wslpath -u 'C:\'` is `<root>c/`; the root is what's left without the drive.
  const mountRoot = /^(.*\/)[a-z]\/?$/i.exec(mount)?.[1] ?? '/mnt/'
  const claudeDir = kv.get('cfg') || `${home}/.claude`
  return {
    distro: name,
    ok: true,
    user: kv.get('user') ?? '',
    home: posixNormalize(home),
    shell: kv.get('shell') ?? '/bin/sh',
    mountRoot,
    networking: kv.get('net') ?? '',
    interop: kv.get('interop') === '1',
    exeReachable: kv.get('exe') === '1',
    claudePath: kv.get('claude') ?? '',
    claudeDir: posixNormalize(claudeDir),
    gitVersion: kv.get('git') ?? '',
    launchShell: kv.get('launch') || '/bin/sh',
    exeLinux: kv.get('exepath') ?? '',
  }
}

/**
 * What `distro` says about itself. Cached for the run once it answers; a failure is
 * not cached, so a distro that was merely stopped or mid-install gets asked again.
 */
export function probe(distro: string, force = false): Promise<Probe> {
  const key = distro.toLowerCase()
  if (!force) {
    const hit = probes.get(key)
    if (hit) return Promise.resolve(hit)
  }
  const pending = inflight.get(key)
  if (pending) return pending
  const p = runProbe(distro)
    .then((res) => {
      if (res.ok) probes.set(key, res)
      else probes.delete(key)
      return res
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

export function cachedProbe(distro: string): Probe | undefined {
  return probes.get(distro.toLowerCase())
}

/**
 * A probe that has to have worked. Throws a sentence fit for a status line when the
 * distro can't be reached, or can't reach back — the route every status report,
 * and Ctrl+G, takes home.
 */
export async function readyProbe(distro: string): Promise<Probe> {
  const p = await probe(distro)
  if (!p.ok) throw new Error(p.reason || `couldn't reach ${distro}`)
  return p
}

/** A Windows path as the probed distro names it, or null when it can't reach it. */
export function winToLinux(p: Probe, winPath: string): string | null {
  return hostToLinux(p.distro, winPath, p.mountRoot)
}

// ---- folders -------------------------------------------------------------------

/** `~` and `~/x` in the distro user's home. */
export function expandLinuxHome(p: Probe, path: string): string {
  if (path === '~') return p.home
  if (path.startsWith('~/')) return posixNormalize(`${p.home}/${path.slice(2)}`)
  return path
}

/**
 * The real path of an existing folder inside the distro (symlinks resolved), or an
 * error saying it isn't there. Resolved because Claude files a transcript under the
 * real working directory, and Windows can't follow a Linux symlink to find it.
 */
export async function realDirIn(distro: string, linux: string): Promise<string> {
  // The path rides inside the script rather than argv, so no quoting it carries has
  // to survive the trip through a Windows command line.
  const r = await wslExec(distro, '/', ['sh', '-s'], {
    input: `cd -- ${shquote(linux)} 2>/dev/null && pwd -P`,
    timeoutMs: 20_000,
  })
  const real = r.stdout.trim().split('\n').pop() ?? ''
  if (r.code !== 0 || !real.startsWith('/')) {
    throw new Error(`there's no folder ${linux} in ${distro}`)
  }
  return real
}

/**
 * A create request, with its folder turned into what a session stores. A WSL share
 * path picks its distro whatever the request said; a request for a distro gets its
 * `~`, drive and share paths turned into Linux ones and resolved inside the distro.
 * Anything else is a Windows request and comes back untouched.
 */
export async function normalizeCreateInput(input: CreateSessionInput): Promise<CreateSessionInput> {
  const raw = input.projectPath.trim()
  const unc = parseWslUnc(raw)
  let runtime: SessionRuntime | undefined = input.runtime?.kind === 'wsl' ? input.runtime : undefined
  if (unc) runtime = { kind: 'wsl', distro: unc.distro }
  if (!runtime) return input

  const distro = await canonicalDistro(runtime.distro)
  if (!distro) throw new Error(`there is no WSL distro called "${runtime.distro}"`)
  const p = await readyProbe(distro)
  let linux: string | null
  if (unc) linux = unc.linux
  else if (looksLinux(raw)) linux = expandLinuxHome(p, raw)
  else linux = hostToLinux(distro, raw, p.mountRoot)
  if (!linux) throw new Error(`${raw} isn't somewhere ${distro} can reach`)
  linux = posixNormalize(linux)
  // A browser session's folder only picks its sidebar group; it never runs there.
  if (input.kind !== 'browser') linux = await realDirIn(distro, linux)
  return { ...input, projectPath: linux, runtime: { kind: 'wsl', distro } }
}

// ---- leftover processes --------------------------------------------------------

/**
 * Stopping a WSL session kills wsl.exe, and Linux learns of it only as a hang-up on
 * the terminal. A Claude that takes its time over that — or a child in a process
 * group of its own — can outlive it, and a relaunch would then put two Claudes on
 * one transcript. So: TERM whatever still carries the session id in its command
 * line, wait up to two seconds, then KILL.
 *
 * The id only ever appears in Claude's own argv (the launch command reaches the
 * shell through an environment variable, not argv). The pattern is written as
 * `[x]yz…` so it matches the id but not itself, in this script's own argv.
 *
 * The script travels in argv, not on stdin like the others here: at quit the app is
 * gone before a pipe to it could be flushed, and a `sh -s` left waiting on a stdin
 * nobody closes never exits. So it is written to survive the Windows command line —
 * no double quotes anywhere — with globbing off, since the pattern is left unquoted.
 */
const REAP_SCRIPT = [
  'set -f',
  'pkill -TERM -f -- $1 2>/dev/null',
  'i=0',
  'while [ $i -lt 20 ]; do pgrep -f -- $1 >/dev/null 2>&1 || exit 0; sleep 0.1; i=$((i+1)); done',
  'pkill -KILL -f -- $1 2>/dev/null',
  'exit 0',
].join('; ')

function reapArgs(distro: string, id: string): string[] {
  return ['-d', distro, '--cd', '/', '--exec', 'sh', '-c', REAP_SCRIPT, 'sh', `[${id[0]}]${id.slice(1)}`]
}

export async function reap(distro: string, sessionId: string): Promise<void> {
  await run(reapArgs(distro, sessionId), { timeoutMs: 5_000 })
}

/** Quit-time reap: fire and forget, surviving this process. */
export function reapDetached(distro: string, sessionIds: string[]): void {
  for (const id of sessionIds) {
    try {
      const child = spawn(wslExe(), reapArgs(distro, id), {
        windowsHide: true,
        detached: true,
        env: { ...process.env, WSL_UTF8: '1' },
        stdio: 'ignore',
      })
      child.on('error', () => {})
      child.unref()
    } catch {
      // best effort — quitting isn't the moment to report anything
    }
  }
}

// ---- Ctrl+G shim -----------------------------------------------------------------

const shims = new Map<string, string>()

/**
 * Write `source` to `~/.cache/terminator/prompt-editor` inside the distro and return
 * its Linux path. Rewritten on the first use each run, because what it points at —
 * this app's executable — moves: the portable build unpacks to a fresh temp folder
 * on every launch.
 */
export async function ensurePromptShim(
  distro: string,
  source: string,
): Promise<{ path: string } | { reason: string }> {
  const key = distro.toLowerCase()
  const hit = shims.get(key)
  if (hit) return { path: hit }
  const marker = '__TERMINATOR_SHIM__'
  const script = [
    'set -e',
    'd="$HOME/.cache/terminator"',
    'mkdir -p "$d"',
    `cat > "$d/prompt-editor" <<'${marker}'`,
    source.replace(/\n$/, ''),
    marker,
    'chmod 700 "$d/prompt-editor"',
    'printf "__T_shim=%s\\n" "$d/prompt-editor"',
  ].join('\n')
  const r = await wslExec(distro, '/', ['sh', '-s'], { input: script, timeoutMs: 20_000 })
  const path = /^__T_shim=(.*)$/m.exec(r.stdout)?.[1]?.trim() ?? ''
  if (r.code !== 0 || !path) {
    return { reason: `the helper couldn't be written in ${distro}: ${(r.stderr || 'no reason given').slice(0, 120)}` }
  }
  // Claude splits $VISUAL on spaces with no quoting, so the path has to have none.
  if (/\s/.test(path)) {
    return { reason: `Claude's editor setting can't hold a path with a space in it, and ${path} has one.` }
  }
  shims.set(key, path)
  return { path }
}
