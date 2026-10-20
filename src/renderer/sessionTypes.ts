import type { CreateSessionInput, SessionRuntime, WslDistro } from '../shared/types'
import { parseWslUnc } from '../shared/wsl-path'
import { C } from './theme'
import type { IconName } from './icons'

/**
 * The kinds of session you can create, as one list shared by the New Session
 * dialog and the sidebar's "New session here" menu — so the two can never drift
 * apart on wording, icon or what they actually create. `kind` and `mode` are
 * separate on a Session (there is no read-only *kind*), which is why this extra
 * key exists at all.
 */
export type TypeKey = 'claude' | 'claude-ro' | 'shell' | 'editor' | 'browser' | 'pdf'

export const TYPES: {
  key: TypeKey
  icon: IconName
  color: string
  label: string
  desc: string
}[] = [
  { key: 'claude', icon: 'sparkle', color: C.accent, label: 'Claude', desc: 'Normal Claude Code session' },
  { key: 'claude-ro', icon: 'lock', color: C.muted, label: 'Claude · read-only', desc: 'Runs the read-only command' },
  { key: 'shell', icon: 'terminal', color: C.kindIcon, label: 'Terminal', desc: 'Plain shell — no Claude features' },
  { key: 'editor', icon: 'editor', color: C.kindIcon, label: 'Editor', desc: 'Browse and edit files — no Claude, no shell' },
  { key: 'browser', icon: 'globe', color: C.kindIcon, label: 'Browser', desc: 'A web page, in the app — keeps its own sign-ins' },
  { key: 'pdf', icon: 'pdf', color: C.kindIcon, label: 'PDF', desc: "A PDF from the project, read in the app's theme" },
]

export const TYPE_MAP: Record<TypeKey, Pick<CreateSessionInput, 'kind' | 'mode'>> = {
  claude: { kind: 'claude', mode: 'normal' },
  'claude-ro': { kind: 'claude', mode: 'readonly' },
  shell: { kind: 'shell', mode: 'normal' },
  editor: { kind: 'editor', mode: 'normal' },
  browser: { kind: 'browser', mode: 'normal' },
  pdf: { kind: 'pdf', mode: 'normal' },
}

/**
 * A folder as someone gave it, settled into what a create request carries: a
 * \\wsl.localhost path picks its distro and becomes the Linux path it stands for,
 * and a bare `/…` path — which means nothing on Windows — goes to the default
 * distro. Anything else keeps the runtime already chosen.
 *
 * The New Session dialog runs this on every folder it is given, and a scripted
 * `terminator new` runs it on `--project`, so the two read a path the same way.
 */
export function settleFolder(
  raw: string,
  runtime: SessionRuntime | undefined,
  distros: WslDistro[],
): { folder: string; runtime: SessionRuntime | undefined } {
  const unc = parseWslUnc(raw)
  if (unc) {
    // The registered spelling of a distro named in a path, which may be any case.
    const distro = distros.find((d) => d.name.toLowerCase() === unc.distro.toLowerCase())?.name ?? unc.distro
    return { folder: unc.linux, runtime: { kind: 'wsl', distro } }
  }
  if (!runtime && distros.length && raw.startsWith('/') && !raw.startsWith('//')) {
    const distro = distros.find((d) => d.isDefault)?.name ?? distros[0]?.name ?? ''
    return { folder: raw, runtime: { kind: 'wsl', distro } }
  }
  return { folder: raw, runtime }
}

/**
 * The create request for what the New Session dialog's fields say. Shared with a
 * scripted `terminator new`, whose flags are those same fields — so a name left
 * blank, or a branch box left empty, means the same thing from either one.
 */
export function newSessionInput(f: {
  type: TypeKey
  name: string
  folder: string
  worktree: boolean
  branch: string
  runtime?: SessionRuntime
  pdfFile?: string
}): CreateSessionInput {
  return {
    ...TYPE_MAP[f.type],
    name: f.name.trim() || undefined,
    projectPath: f.folder.trim(),
    worktree: f.worktree,
    // The branch box is only read with the worktree switch on.
    branch: f.worktree ? f.branch.trim() || undefined : undefined,
    ...(f.runtime ? { runtime: f.runtime } : {}),
    ...(f.type === 'pdf' ? { file: f.pdfFile } : {}),
  }
}
