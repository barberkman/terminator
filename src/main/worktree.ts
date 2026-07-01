import { shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { loadSettings } from './settings'
import { expandHome } from './pty-manager'
import { getSession, updateSession } from './state'

const pExecFile = promisify(execFile)

/** Launch the user's configured git GUI on a session's folder. App never merges. */
export function openGitGui(id: string): void {
  const s = getSession(id)
  if (!s) return
  const folder = expandHome(s.worktreePath || s.projectPath) || s.projectPath
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
export function openInFolder(id: string): void {
  const s = getSession(id)
  if (!s) return
  const folder = expandHome(s.worktreePath || s.projectPath) || s.projectPath
  // Resolves to '' on success, an error string on failure — ignored (best effort).
  void shell.openPath(folder)
}

/** `git worktree add <root>/<branch> -b <branch>` from a repo. Returns the new path. */
export async function addWorktree(repoPath: string, branch: string): Promise<string> {
  const repo = expandHome(repoPath) || repoPath
  const root = expandHome(loadSettings().worktreesRoot) || loadSettings().worktreesRoot
  const safe = branch.replace(/[^A-Za-z0-9._-]+/g, '-')
  const path = join(root, safe)
  await pExecFile('git', ['-C', repo, 'worktree', 'add', path, '-b', branch])
  return path
}

export async function removeWorktree(id: string): Promise<void> {
  const s = getSession(id)
  if (!s || !s.worktreePath) return
  const repo = expandHome(s.projectPath) || s.projectPath
  await pExecFile('git', ['-C', repo, 'worktree', 'remove', s.worktreePath, '--force'])
  updateSession(id, { worktreePath: undefined })
}
