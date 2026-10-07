import { shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type { FolderChoice, OpenFileResult, Session, SessionRuntime } from '../shared/types'
import { editorLabel } from '../shared/editor-name'
import { hostFolder, isWsl, posixNormalize, sessionFolder } from '../shared/wsl-path'
import { loadSettings } from './settings'
import { editorArgv, launchDetached } from './links'
import { expandHome } from './pty-manager'
import { getSession, updateSession } from './state'
import { findCommand, shquote } from './shell'
import { expandLinuxHome, readyProbe, wslCheck, wslExe } from './wsl'

const pExecFile = promisify(execFile)

/**
 * Which folder an action means. 'session' is the app-wide `worktreePath ||
 * projectPath` idiom and stays the default; 'project' is the repo the worktree
 * was cut from. Resolved here from the session id — the renderer names a choice,
 * never a path, the same posture every other path in the app is held to.
 *
 * This is the folder as *this* process reaches it: a WSL session's is its distro's
 * \\wsl.localhost share, which Explorer and Windows programs can open.
 */
function folderFor(s: Session, which: FolderChoice = 'session'): string {
  if (isWsl(s)) return hostFolder(s, which)
  const raw = which === 'project' ? s.projectPath : s.worktreePath || s.projectPath
  return expandHome(raw) || s.projectPath
}

/** Launch the user's configured git GUI on a session's folder. App never merges. */
export function openGitGui(id: string, which?: FolderChoice): void {
  const s = getSession(id)
  if (!s) return
  // A WSL session can have a GUI of its own, run inside the distro (WSLg). Without
  // one it gets the Windows GUI, pointed at the folder's share.
  const wslCmd = isWsl(s) ? loadSettings().wsl.gitGuiCommand.trim() : ''
  if (isWsl(s) && wslCmd) {
    const folder = sessionFolder(s, which)
    const child = spawn(
      wslExe(),
      ['-d', s.runtime.distro, '--cd', folder, '--exec', 'sh', '-lc', `exec ${wslCmd} ${shquote(folder)}`],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.on('error', () => {
      /* distro gone / bad command — no-op (best effort) */
    })
    child.unref()
    return
  }
  const folder = folderFor(s, which)
  const cmd = loadSettings().gitGuiCommand.trim()
  if (!cmd) return
  const parts = cmd.split(/\s+/)
  const child = spawn(parts[0], [...parts.slice(1), folder], {
    cwd: folder,
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => {
    /* GUI not installed / bad command — no-op (best effort) */
  })
  child.unref()
}

/** Open a session's folder in the OS default file manager. Best effort. */
export function openInFolder(id: string, which?: FolderChoice): void {
  const s = getSession(id)
  if (!s) return
  const folder = folderFor(s, which)
  // Resolves to '' on success, an error string on failure — ignored (best effort).
  void shell.openPath(folder)
}

/**
 * `launchDetached`, plus what Windows needs for an editor named the way people
 * type it. `code` there is `code.cmd`, and Node won't spawn a batch file without a
 * shell since the 2024 argument-injection fix — so a bare name is looked up on
 * PATH first, and a batch file is run through cmd.exe with every argument
 * double-quoted. Quotes don't stop cmd expanding `%VAR%`, and a `"` can't be
 * quoted at all, so an argument holding either is refused rather than mangled.
 */
async function launchEditor(exe: string, args: string[]): Promise<string | null> {
  if (process.platform !== 'win32') return launchDetached(exe, args)
  const resolved = /[\\/]/.test(exe) ? exe : (findCommand(exe) ?? exe)
  if (!/\.(cmd|bat)$/i.test(resolved)) return launchDetached(resolved, args)
  const argv = [resolved, ...args]
  if (argv.some((a) => /["%]/.test(a))) {
    return `cmd.exe can't pass a " or % through safely — set the editor's .exe in Settings instead`
  }
  const line = argv.map((a) => `"${a}"`).join(' ')
  return launchDetached(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    windowsHide: true,
    windowsVerbatimArguments: true,
  })
}

/**
 * Open a session's folder in the project editor from Settings (VS Code unless
 * changed). Unlike the two above it reports back: it's a button pressed expecting
 * a window, and a silent nothing would read as the button being broken.
 */
export async function openProjectEditor(id: string, which?: FolderChoice): Promise<OpenFileResult> {
  const s = getSession(id)
  if (!s) return { ok: false, reason: 'that session is gone' }
  const editor = loadSettings().projectEditor
  const command = editor.command.trim()
  if (!command) return { ok: false, reason: 'no project editor is set in Settings' }
  const name = editorLabel(editor)
  const exe = expandHome(command) || command
  const error = await launchEditor(exe, editorArgv(editor.args ?? [], folderFor(s, which)))
  if (error) return { ok: false, reason: `${name} wouldn't start: ${error.slice(0, 140)}` }
  return { ok: true, editor: name }
}

/**
 * `git worktree add <root>/<branch> -b <branch>` from a repo. Returns the new path.
 *
 * A WSL project's worktree is made by the distro's own git, under the Linux
 * `wsl.worktreesRoot`: Windows git would write Windows paths into the worktree's
 * metadata, which the Linux git that Claude runs in there can't follow. Relative
 * paths where git supports them (2.48+), so the link also survives being opened
 * from Windows through the share.
 */
export async function addWorktree(
  repoPath: string,
  branch: string,
  runtime?: SessionRuntime,
): Promise<string> {
  const safe = branch.replace(/[^A-Za-z0-9._-]+/g, '-')
  if (runtime && isWsl({ runtime })) {
    const p = await readyProbe(runtime.distro)
    const root = expandLinuxHome(p, loadSettings().wsl.worktreesRoot.trim() || '~/terminator-worktrees')
    if (!root.startsWith('/')) throw new Error(`the WSL worktrees root must be a Linux path, not ${root}`)
    const path = posixNormalize(`${root}/${safe}`)
    const m = /(\d+)\.(\d+)/.exec(p.gitVersion)
    const relative = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 48))
    await wslCheck(
      p.distro,
      repoPath,
      ['git', 'worktree', 'add', ...(relative ? ['--relative-paths'] : []), path, '-b', branch],
      { timeoutMs: 60_000 },
    )
    return path
  }
  const repo = expandHome(repoPath) || repoPath
  const root = expandHome(loadSettings().worktreesRoot) || loadSettings().worktreesRoot
  const path = join(root, safe)
  await pExecFile('git', ['-C', repo, 'worktree', 'add', path, '-b', branch], { windowsHide: true })
  return path
}

export async function removeWorktree(id: string): Promise<void> {
  const s = getSession(id)
  if (!s || !s.worktreePath) return
  if (isWsl(s)) {
    await wslCheck(s.runtime.distro, s.projectPath, ['git', 'worktree', 'remove', s.worktreePath, '--force'], {
      timeoutMs: 60_000,
    })
  } else {
    const repo = expandHome(s.projectPath) || s.projectPath
    await pExecFile('git', ['-C', repo, 'worktree', 'remove', s.worktreePath, '--force'], {
      windowsHide: true,
    })
  }
  updateSession(id, { worktreePath: undefined })
}
