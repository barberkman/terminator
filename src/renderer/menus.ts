import type { FolderChoice, Session, Settings } from '../shared/types'
import type { IconName } from './icons'
import type { MenuNode } from './components/ContextMenu'
import { TYPES, TYPE_MAP, type TypeKey } from './sessionTypes'
import * as registry from './term/registry'
import { PANE_LABELS, useStore, type LayoutName, type MenuTarget } from './state/store'

// ---- actions ---------------------------------------------------------------
// The menu model is pure — the same context always yields the same rows in the
// same order. These closures are the payload it carries, kept here so
// ContextMenu.tsx stays a menu and knows nothing about sessions.

/** Create a session in a folder and show it. No dialog, nothing to re-pick. */
async function createSessionIn(
  type: TypeKey,
  project: { name: string; path: string },
): Promise<void> {
  const s = await window.terminator.createSession({
    ...TYPE_MAP[type],
    projectName: project.name,
    projectPath: project.path,
  })
  const store = useStore.getState()
  store.upsert(s)
  store.openSession(s.id)
}

/**
 * Start a session that may not be in any pane. The terminal has to exist *first*:
 * the pty stream is written straight into the session's xterm
 * (`registry.wireGlobalStreams`), and output for a session with no terminal is
 * dropped on the floor with no main-side scrollback to recover it from.
 * getOrCreate parks one in the offscreen holder, which is exactly what it's for.
 */
function startFromSidebar(id: string): void {
  registry.getOrCreate(id)
  const { cols, rows } = registry.refit(id)
  void window.terminator.startSession(id, cols, rows)
}

function copyPath(path: string, what: string): void {
  window.terminator.clipboardWrite(path)
  useStore.getState().pushToast({ tone: 'ok', text: `Copied ${what}`, sub: path, icon: 'copy' })
}

/** Build/Run for a project, reusing that project's one terminal per task. */
export async function runProjectTask(
  project: { name: string; path: string },
  task: 'build' | 'run',
): Promise<void> {
  const store = useStore.getState()
  let target = Object.values(store.sessions).find(
    (x) => x.task === task && x.projectPath === project.path,
  )
  if (!target) {
    target = await window.terminator.createSession({
      kind: 'shell',
      mode: 'normal',
      task,
      name: task === 'build' ? 'Build' : 'Run',
      projectName: project.name,
      projectPath: project.path,
    })
    store.upsert(target)
  }
  store.openSession(target.id)
  await window.terminator.runTaskCommand(target.id, task)
}

/** Types the stop command into an existing Run terminal — never creates one. */
export async function stopProjectTask(runSessionId: string): Promise<void> {
  useStore.getState().openSession(runSessionId)
  await window.terminator.runTaskCommand(runSessionId, 'stop')
}

// ---- model -----------------------------------------------------------------

export interface MenuCtx {
  target: MenuTarget
  /** Resolved sessions for a 'sessions' target; empty for a project target. */
  sessions: Session[]
  /** The project the menu is about. */
  project: { name: string; path: string } | null
  /** Sessions belonging to that project — the project menu's Run/Stop need them. */
  projectSessions: Session[]
  layout: LayoutName
  panes: string[]
  /** Index into `panes` of the split that currently has focus. */
  focused: number
  settings: Settings | null
  collapsed: Record<string, boolean>
}

/**
 * Join groups with separators, dropping empty ones. This one helper is what
 * makes the menu context-sensitive rather than greyed out: a group that has
 * nothing to offer disappears *and* takes its rule with it, so no menu ever ends
 * up with a doubled or trailing separator.
 */
function joinGroups(groups: MenuNode[][]): MenuNode[] {
  const out: MenuNode[] = []
  for (const g of groups) {
    if (!g.length) continue
    if (out.length) out.push({ kind: 'sep' })
    out.push(...g)
  }
  return out
}

/** The four session types, as menu rows that create in `project` immediately. */
function typeItems(project: { name: string; path: string }, keyPrefix: string): MenuNode[] {
  return TYPES.map((t) => ({
    kind: 'item' as const,
    id: `${keyPrefix}:${t.key}`,
    label: t.label,
    icon: t.icon,
    run: () => void createSessionIn(t.key, project),
  }))
}

function moreOptions(project: { name: string; path: string }): MenuNode {
  return {
    kind: 'item',
    id: 'new:more',
    label: 'More options…',
    icon: 'settings',
    note: 'name, worktree',
    run: () =>
      useStore
        .getState()
        .setShowNew(true, { projectPath: project.path, projectName: project.name }),
  }
}

/**
 * A session's folders. When it has a worktree it points at two that are not
 * interchangeable — starting a second Claude in the worktree means two agents on
 * one working copy, while a terminal there is exactly how you test what the first
 * one wrote — so every folder-scoped action names which one it means.
 */
interface Folders {
  /** The session's own folder: the worktree when it has one, else the project. */
  session: { label: string; path: string; project: { name: string; path: string } }
  /** The repo the worktree was cut from. Null when there is no worktree, so the
   *  extra menu level disappears entirely for an ordinary session. */
  project: { label: string; path: string; project: { name: string; path: string } } | null
}

function foldersOf(s: Session): Folders {
  const asProject = { name: s.projectName, path: s.projectPath }
  if (!s.worktreePath) {
    return { session: { label: s.projectName, path: s.projectPath, project: asProject }, project: null }
  }
  return {
    session: {
      label: `worktree ⑂ ${s.branch}`,
      path: s.worktreePath,
      // A session created here runs *in* the worktree but still belongs to this
      // project's group. It gets no worktreePath of its own, so it never offers
      // to delete a worktree it doesn't own — that stays with the session that made it.
      project: { name: s.projectName, path: s.worktreePath },
    },
    project: { label: `project ${s.projectName}`, path: s.projectPath, project: asProject },
  }
}

/**
 * One folder-scoped action. With a worktree it becomes a submenu naming the two
 * folders; without one it stays a plain row.
 */
function folderAction(
  id: string,
  label: string,
  icon: IconName,
  f: Folders,
  run: (which: FolderChoice, folder: { label: string; path: string }) => void,
): MenuNode {
  if (!f.project) {
    return { kind: 'item', id, label, icon, run: () => run('session', f.session) }
  }
  return {
    kind: 'sub',
    id,
    label,
    icon,
    items: [
      {
        kind: 'item',
        id: `${id}:worktree`,
        label: `In the ${f.session.label}`,
        note: 'worktree',
        run: () => run('session', f.session),
      },
      {
        kind: 'item',
        id: `${id}:project`,
        label: `In the ${f.project.label}`,
        note: 'repo',
        run: () => run('project', f.project!),
      },
    ],
  }
}

function headingSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.target.kind === 'project') {
    const n = ctx.projectSessions.length
    return [
      {
        kind: 'heading',
        label: `${ctx.target.name} · ${n} session${n === 1 ? '' : 's'}`,
        sub: ctx.target.path,
      },
    ]
  }
  const s = ctx.sessions[0]
  if (!s) return []
  if (ctx.sessions.length > 1) {
    return [{ kind: 'heading', label: `${ctx.sessions.length} sessions` }]
  }
  return [{ kind: 'heading', label: s.name, sub: `${s.projectName} · ${s.branch}` }]
}

function openSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.sessions.length !== 1) return []
  const s = ctx.sessions[0]
  const out: MenuNode[] = []
  // Nothing to offer when it's already the split you're in: openSession would
  // leave `focused` where it is and nothing would happen. A row that does nothing
  // is worse than a row that isn't there.
  if (ctx.panes[ctx.focused] !== s.id) {
    out.push({
      kind: 'item',
      id: 'open',
      // Already on screen, just not the split you're typing in — this moves you
      // to it rather than opening it anywhere new.
      label: ctx.panes.includes(s.id) ? 'Focus' : 'Open',
      icon: 'single',
      run: () => useStore.getState().openSession(s.id),
    })
  }
  // With one pane there is no choice to offer, so the submenu isn't there at all.
  if (ctx.panes.length < 2) return out
  const labels = PANE_LABELS[ctx.layout]
  return [
    ...out,
    {
      kind: 'sub',
      id: 'open-split',
      label: 'Open in split',
      icon: ctx.layout === 'grid4' ? 'grid' : 'columns',
      items: ctx.panes.map((occupant, i) => {
        const here = useStore.getState().sessions[occupant]
        return {
          kind: 'item' as const,
          id: `split:${i}`,
          label: labels[i] ?? `Split ${i + 1}`,
          note: here ? here.name : 'empty',
          checked: occupant === s.id,
          run: () => useStore.getState().openInPane(s.id, i),
        }
      }),
    },
  ]
}

function newSessionSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.target.kind === 'project') {
    const p = { name: ctx.target.name, path: ctx.target.path }
    return [
      {
        kind: 'sub',
        id: 'new',
        label: 'New session in this project',
        icon: 'plus',
        items: [...typeItems(p, 'new'), { kind: 'sep' }, moreOptions(p)],
      },
    ]
  }
  if (ctx.sessions.length !== 1) return []
  const s = ctx.sessions[0]
  const f = foldersOf(s)
  // No worktree: one flat list of types. With a worktree the folder is chosen
  // first, because which working copy the new session lands in is the whole point.
  const items: MenuNode[] = f.project
    ? [
        {
          kind: 'sub',
          id: 'new:wt',
          label: `In the ${f.session.label}`,
          icon: 'branch',
          items: typeItems(f.session.project, 'new-wt'),
        },
        {
          kind: 'sub',
          id: 'new:proj',
          label: `In the ${f.project.label}`,
          icon: 'folder',
          items: typeItems(f.project.project, 'new-proj'),
        },
        { kind: 'sep' },
        moreOptions(f.project.project),
      ]
    : [...typeItems(f.session.project, 'new'), { kind: 'sep' }, moreOptions(f.session.project)]
  return [{ kind: 'sub', id: 'new', label: 'New session here', icon: 'plus', items }]
}

function editSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.sessions.length !== 1) return []
  const s = ctx.sessions[0]
  const out: MenuNode[] = [
    {
      kind: 'item',
      id: 'rename',
      label: 'Rename',
      icon: 'pencil',
      run: () => useStore.getState().startEdit(s.id, 'sidebar'),
    },
  ]
  if (s.kind === 'claude') {
    const ro = s.mode === 'readonly'
    out.push({
      kind: 'item',
      id: 'mode',
      label: ro ? 'Switch to normal mode' : 'Switch to read-only',
      icon: ro ? 'unlock' : 'lock',
      // switchMode only relaunches a live session; say so rather than looking broken.
      note: s.alive ? undefined : 'on next start',
      run: () => void window.terminator.setMode(s.id, ro ? 'normal' : 'readonly'),
    })
    // A session that never ran has no transcript, so the branch picker would
    // open onto an empty list.
    if (s.everStarted) {
      out.push({
        kind: 'item',
        id: 'branch',
        label: 'Branch this conversation…',
        icon: 'branch',
        run: () => useStore.getState().setBranchFor(s.id),
      })
    }
    if (s.parentId && useStore.getState().sessions[s.parentId]) {
      out.push({
        kind: 'item',
        id: 'parent',
        label: `Open ${s.branchedFrom ?? 'parent session'}`,
        icon: 'branch',
        note: 'parent',
        run: () => useStore.getState().openSession(s.parentId!),
      })
    }
  }
  return out
}

function folderSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.target.kind === 'project') {
    const id = ctx.projectSessions[0]?.id
    if (!id) return []
    const path = ctx.target.path
    return [
      {
        kind: 'item',
        id: 'copy',
        label: 'Copy project path',
        icon: 'copy',
        run: () => copyPath(path, 'project path'),
      },
      {
        kind: 'item',
        id: 'folder',
        label: 'Open folder',
        icon: 'folder',
        run: () => void window.terminator.openInFolder(id, 'project'),
      },
      {
        kind: 'item',
        id: 'git',
        label: 'Open in git tool',
        icon: 'git',
        run: () => void window.terminator.openGitGui(id, 'project'),
      },
    ]
  }
  if (ctx.sessions.length !== 1) return []
  const s = ctx.sessions[0]
  const f = foldersOf(s)
  return [
    folderAction('copy', 'Copy path', 'copy', f, (_w, folder) =>
      copyPath(folder.path, folder.label),
    ),
    folderAction('folder', 'Open folder', 'folder', f, (which) =>
      void window.terminator.openInFolder(s.id, which),
    ),
    folderAction('git', 'Open in git tool', 'git', f, (which) =>
      void window.terminator.openGitGui(s.id, which),
    ),
  ]
}

function processSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.sessions.length !== 1) return []
  const s = ctx.sessions[0]
  // An editor pane has no process at all, so Start/Stop/Relaunch would be lies.
  if (s.kind === 'editor') return []
  // Never both: `alive` is the only truth here — a restored session comes back
  // everStarted: true but not running.
  if (!s.alive) {
    return [
      {
        kind: 'item',
        id: 'start',
        label: 'Start',
        icon: 'play',
        note: s.everStarted && s.kind === 'claude' ? 'resumes' : undefined,
        run: () => startFromSidebar(s.id),
      },
    ]
  }
  return [
    {
      kind: 'item',
      id: 'relaunch',
      label: 'Relaunch',
      icon: 'restart',
      run: () => void window.terminator.relaunchSession(s.id),
    },
    {
      kind: 'item',
      id: 'stop',
      label: 'Stop',
      icon: 'stop',
      run: () => void window.terminator.stopSession(s.id),
    },
  ]
}

/**
 * Destructive actions, last and separated, each keeping the confirmation step
 * that already guards it. There is no Close: it was only ever a second word for
 * Remove (both ran the same removeFlow), and now that Stop ends a process without
 * destroying anything, the pair that means something is Stop and Remove.
 */
function destructiveSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.sessions.length !== 1) return []
  const s = ctx.sessions[0]
  const out: MenuNode[] = []
  if (s.worktreePath) {
    out.push({
      kind: 'item',
      id: 'rm-worktree',
      label: 'Remove worktree…',
      icon: 'branch',
      danger: true,
      run: () => useStore.getState().setConfirm({ kind: 'worktree', id: s.id, name: s.name }),
    })
  }
  out.push({
    kind: 'item',
    id: 'remove',
    label: 'Remove session…',
    icon: 'close',
    danger: true,
    run: () => useStore.getState().setConfirm({ kind: 'remove', id: s.id, name: s.name }),
  })
  return out
}

function projectTaskSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.target.kind !== 'project') return []
  const p = { name: ctx.target.name, path: ctx.target.path }
  const cfg = ctx.settings?.projects.find((x) => x.path === p.path)
  const runSession = ctx.projectSessions.find((s) => s.task === 'run')
  const out: MenuNode[] = []
  // Configured or absent — the header's dimmed-button treatment doesn't come along.
  if (cfg?.buildCommand?.trim()) {
    out.push({
      kind: 'item',
      id: 'build',
      label: 'Build',
      icon: 'hammer',
      run: () => void runProjectTask(p, 'build'),
    })
  }
  if (cfg?.runCommand?.trim()) {
    out.push({
      kind: 'item',
      id: 'run',
      label: 'Run',
      icon: 'play',
      run: () => void runProjectTask(p, 'run'),
    })
  }
  if (runSession && cfg?.stopCommand?.trim()) {
    out.push({
      kind: 'item',
      id: 'stop-task',
      label: 'Stop',
      icon: 'stop',
      run: () => void stopProjectTask(runSession.id),
    })
  }
  return out
}

function projectViewSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.target.kind !== 'project') return []
  const name = ctx.target.name
  // Project groups key `collapsed` by name; branch subtrees use branchKey(id).
  const isCollapsed = !!ctx.collapsed[name]
  return [
    {
      kind: 'item',
      id: 'collapse',
      label: isCollapsed ? 'Expand group' : 'Collapse group',
      icon: 'chevron',
      run: () => useStore.getState().toggleGroup(name),
    },
  ]
}

/** The whole menu for whatever was right-clicked. */
export function buildMenu(ctx: MenuCtx): MenuNode[] {
  if (ctx.target.kind === 'project') {
    return joinGroups([
      headingSection(ctx),
      newSessionSection(ctx),
      projectTaskSection(ctx),
      folderSection(ctx),
      projectViewSection(ctx),
    ])
  }
  return joinGroups([
    headingSection(ctx),
    openSection(ctx),
    newSessionSection(ctx),
    editSection(ctx),
    folderSection(ctx),
    processSection(ctx),
    destructiveSection(ctx),
  ])
}
