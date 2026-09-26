import {
  isProcessless,
  type AttachedItem,
  type FolderChoice,
  type Session,
  type SessionRuntime,
  type Settings,
} from '../shared/types'
import { findProject, groupKey, isWsl, runtimeLabel, sameRuntime } from '../shared/wsl-path'
import type { IconName } from './icons'
import type { MenuNode } from './components/ContextMenu'
import { TYPES, TYPE_MAP, type TypeKey } from './sessionTypes'
import * as registry from './term/registry'
import { externalEditor } from './term/links'
import { useStore, type MenuTarget } from './state/store'

// ---- actions ---------------------------------------------------------------
// The menu model is pure — the same context always yields the same rows in the
// same order. These closures are the payload it carries, kept here so
// ContextMenu.tsx stays a menu and knows nothing about sessions.

/**
 * A project as the menus act on it: a folder *in a runtime*. A WSL project's path
 * is a Linux one, and everything made from here — a new session, a Build terminal —
 * has to run there too, so the runtime travels with the path everywhere.
 */
export interface ProjectRef {
  name: string
  path: string
  runtime?: SessionRuntime
}

/** Create a session in a folder and show it. No dialog, nothing to re-pick. */
async function createSessionIn(type: TypeKey, project: ProjectRef): Promise<void> {
  let s: Session
  try {
    s = await window.terminator.createSession({
      ...TYPE_MAP[type],
      projectName: project.name,
      projectPath: project.path,
      ...(project.runtime ? { runtime: project.runtime } : {}),
    })
  } catch (e) {
    // A WSL folder is checked inside its distro, and can be gone or unreachable.
    useStore.getState().pushToast({ tone: 'error', text: "Couldn't create the session", sub: errorText(e) })
    return
  }
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
 *
 * Exported because the startup relaunch prompt starts sessions the same way — off
 * screen, terminal first — and that reason is written down here.
 */
export function startFromSidebar(id: string): void {
  registry.getOrCreate(id)
  const { cols, rows } = registry.refit(id)
  void window.terminator.startSession(id, cols, rows)
}

/** The message of an IPC rejection, without Electron's "Error invoking remote method" preamble. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function copyPath(path: string, what: string): void {
  window.terminator.clipboardWrite(path)
  useStore.getState().pushToast({ tone: 'ok', text: `Copied ${what}`, sub: path, icon: 'copy' })
}

/**
 * What "open" means for this attachment, said out loud. A pasted screenshot going
 * to the system viewer and a dropped .md going to your editor are different enough
 * promises that the card shouldn't make one label cover both — and naming the
 * editor matches how a file link in terminal output already offers itself.
 */
export function openLabel(kind: AttachedItem['kind']): string {
  if (kind === 'dir') return 'Open folder'
  if (kind === 'image') return 'Open image'
  const editor = externalEditor()
  return editor ? `Open in ${editor}` : 'Open file'
}

/** What the OS calls the thing that shows a file in a folder. */
export function fileManagerVerb(): string {
  if (window.terminator.platform === 'win32') return 'Show in Explorer'
  if (window.terminator.platform === 'darwin') return 'Reveal in Finder'
  return 'Show in folder'
}

/**
 * The menu on an attachment toast. Same three verbs the card itself offers, for
 * the same reason the terminal's file links have a menu: the primary click has to
 * pick one meaning, and this is where the others live. Copy path is the one that
 * only exists here — the toast prints the path but you can't select text on a card
 * that's about to disappear.
 */
export function toastMenu(
  action: { path: string; kind: AttachedItem['kind'] },
  run: { open: () => void; reveal: () => void },
): MenuNode[] {
  return [
    // The path, the way the terminal's own link menu heads itself with its target.
    { kind: 'heading', label: action.path },
    {
      kind: 'item',
      id: 'open',
      label: openLabel(action.kind),
      icon: action.kind === 'dir' ? 'folder' : 'file',
      run: run.open,
    },
    { kind: 'item', id: 'reveal', label: fileManagerVerb(), icon: 'folder', run: run.reveal },
    { kind: 'sep' },
    {
      // Copying doesn't dismiss the card: it's usually the step before doing
      // something with the path yourself, and it raises its own toast anyway.
      kind: 'item',
      id: 'copy',
      label: 'Copy path',
      icon: 'copy',
      run: () => copyPath(action.path, 'attachment path'),
    },
  ]
}

/** Build/Run for a project, reusing that project's one terminal per task. */
export async function runProjectTask(project: ProjectRef, task: 'build' | 'run'): Promise<void> {
  const store = useStore.getState()
  let target = Object.values(store.sessions).find(
    (x) => x.task === task && x.projectPath === project.path && sameRuntime(x.runtime, project.runtime),
  )
  if (!target) {
    try {
      target = await window.terminator.createSession({
        kind: 'shell',
        mode: 'normal',
        task,
        name: task === 'build' ? 'Build' : 'Run',
        projectName: project.name,
        projectPath: project.path,
        ...(project.runtime ? { runtime: project.runtime } : {}),
      })
    } catch (e) {
      store.pushToast({ tone: 'error', text: `Couldn't start ${task}`, sub: errorText(e) })
      return
    }
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
  project: ProjectRef | null
  /**
   * Sessions in that project's *folder* — what Build/Run/Stop and the folder
   * actions mean, since those run somewhere rather than on a list of rows.
   */
  projectSessions: Session[]
  /**
   * The sidebar group behind a project target: everything sharing its
   * projectName, in `order`. Empty for a 'sessions' target.
   *
   * Not the same list as `projectSessions`, and the difference is the point.
   * The sidebar groups by name (buildGroups), so a session started *in a
   * worktree* of a project keeps the group's name while carrying the worktree as
   * its path — it sits under the header you right-clicked and is missing from
   * the path-scoped list. Anything that acts on "the group" has to mean the rows
   * you can see.
   */
  groupSessions: Session[]
  panes: string[]
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

/** The five session types, as menu rows that create in `project` immediately. */
function typeItems(project: ProjectRef, keyPrefix: string): MenuNode[] {
  return TYPES.map((t) => ({
    kind: 'item' as const,
    id: `${keyPrefix}:${t.key}`,
    label: t.label,
    icon: t.icon,
    run: () => void createSessionIn(t.key, project),
  }))
}

function moreOptions(project: ProjectRef): MenuNode {
  return {
    kind: 'item',
    id: 'new:more',
    label: 'More options…',
    icon: 'settings',
    note: 'name, worktree',
    run: () =>
      useStore.getState().setShowNew(true, {
        projectPath: project.path,
        projectName: project.name,
        runtime: project.runtime,
      }),
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
  session: { label: string; path: string; project: ProjectRef }
  /** The repo the worktree was cut from. Null when there is no worktree, so the
   *  extra menu level disappears entirely for an ordinary session. */
  project: { label: string; path: string; project: ProjectRef } | null
}

function foldersOf(s: Session): Folders {
  const asProject: ProjectRef = { name: s.projectName, path: s.projectPath, runtime: s.runtime }
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
      project: { name: s.projectName, path: s.worktreePath, runtime: s.runtime },
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
    // The group, not the folder: this heading names the header you right-clicked,
    // and that header prints its own count beside the name. Two counts for one
    // thing on one screen reads as a bug — and the destructive row below acts on
    // the group, so the narrower number would understate what it takes.
    const n = ctx.groupSessions.length
    const where = ctx.target.runtime ? ` · ${runtimeLabel(ctx.target.runtime)}` : ''
    return [
      {
        kind: 'heading',
        label: `${ctx.target.name} · ${n} session${n === 1 ? '' : 's'}`,
        sub: `${ctx.target.path}${where}`,
      },
    ]
  }
  const s = ctx.sessions[0]
  if (!s) return []
  if (ctx.sessions.length > 1) {
    return [{ kind: 'heading', label: `${ctx.sessions.length} sessions` }]
  }
  const where = isWsl(s) ? ` · ${runtimeLabel(s.runtime)}` : ''
  return [{ kind: 'heading', label: s.name, sub: `${s.projectName} · ${s.branch}${where}` }]
}

/**
 * Only the split picker. There is no plain "Open": left-clicking the row already
 * calls openSession, so a menu entry for it would just restate the row's own
 * primary action. Choosing *which* split is the part a click can't do.
 */
function openSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.sessions.length !== 1) return []
  const s = ctx.sessions[0]
  // With one pane there is no choice to offer, so the section isn't there at all.
  if (ctx.panes.length < 2) return []
  // Panes are numbered rather than named. "Left" and "Top right" meant something
  // when there were three fixed layouts; with splits you arrange yourself there is
  // no shape to name, and the `note` — what's actually in the pane — is what
  // identifies it to anyone reading the menu anyway.
  return [
    {
      kind: 'sub',
      id: 'open-split',
      label: 'Open in split',
      icon: 'columns',
      items: ctx.panes.map((occupant, i) => {
        const here = useStore.getState().sessions[occupant]
        return {
          kind: 'item' as const,
          id: `split:${i}`,
          label: `Pane ${i + 1}`,
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
    const p: ProjectRef = { name: ctx.target.name, path: ctx.target.path, runtime: ctx.target.runtime }
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
  // An editor or browser pane has no process at all, so Start/Stop/Relaunch
  // would be lies.
  if (isProcessless(s.kind)) return []
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

/**
 * The group's one destructive row, and the only bulk action in the app.
 *
 * It takes the group as the sidebar draws it — by project name — and not
 * `projectSessions`: a session made in a worktree shares the name but not the
 * path, and it is sitting right there under the header you right-clicked.
 * Removing "all" while visibly leaving one behind would be exactly the kind of
 * lie this menu is built to avoid.
 *
 * Remove, never Close, for the reason destructiveSection already gives. The
 * label doesn't shape-shift at one session either — a group of one is still a
 * group, and a count in the note says the size without rewriting the sentence.
 */
function projectDestructiveSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.target.kind !== 'project') return []
  // Captured before the closure: narrowing on ctx.target doesn't survive into it,
  // the same reason projectTaskSection and projectViewSection read it out first.
  const name = ctx.target.name
  const ids = ctx.groupSessions.map((s) => s.id)
  // A group can't be empty while its header renders, so this is the usual
  // "nothing to offer, so no row and no rule" rather than a case you can reach.
  if (!ids.length) return []
  return [
    {
      kind: 'item',
      id: 'remove-group',
      label: 'Remove all sessions…',
      icon: 'close',
      // The dim right column already states the size of a thing elsewhere in this
      // menu; on the one destructive row the count is the blast radius, read
      // where the pointer already is.
      note: ids.length === 1 ? '1 session' : `${ids.length} sessions`,
      danger: true,
      run: () => useStore.getState().setConfirm({ kind: 'removeGroup', name, ids }),
    },
  ]
}

function projectTaskSection(ctx: MenuCtx): MenuNode[] {
  if (ctx.target.kind !== 'project') return []
  const p: ProjectRef = { name: ctx.target.name, path: ctx.target.path, runtime: ctx.target.runtime }
  const cfg = ctx.settings ? findProject(ctx.settings.projects, p.path, p.runtime) : undefined
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
  // Project groups key `collapsed` by groupKey (the name, for a Windows project);
  // branch subtrees use branchKey(id).
  const key = groupKey({ projectName: ctx.target.name, runtime: ctx.target.runtime })
  const isCollapsed = !!ctx.collapsed[key]
  return [
    {
      kind: 'item',
      id: 'collapse',
      label: isCollapsed ? 'Expand group' : 'Collapse group',
      icon: 'chevron',
      run: () => useStore.getState().toggleGroup(key),
    },
  ]
}

/**
 * Notes and Settings, for the collapsed rail.
 *
 * Both live as icon buttons in the expanded sidebar's header, which the rail
 * doesn't render — so while the sidebar is collapsed this menu is the only way
 * to either of them (Settings has no shortcut at all). There is deliberately no
 * "Show sidebar" row: left-clicking the button this menu hangs off already does
 * that, the same reason openSection offers no plain "Open".
 */
function appSection(): MenuNode[] {
  return [
    {
      kind: 'item',
      id: 'notes',
      label: 'Notes',
      icon: 'note',
      run: () => useStore.getState().setShowNotes(true),
    },
    {
      kind: 'item',
      id: 'settings',
      label: 'Settings',
      icon: 'settings',
      run: () => useStore.getState().setShowSettings(true),
    },
  ]
}

/** The whole menu for whatever was right-clicked. */
export function buildMenu(ctx: MenuCtx): MenuNode[] {
  // No heading and no joinGroups: two rows about the app, with no subject to
  // name and no section that could turn out empty.
  if (ctx.target.kind === 'app') return appSection()
  if (ctx.target.kind === 'project') {
    return joinGroups([
      headingSection(ctx),
      newSessionSection(ctx),
      projectTaskSection(ctx),
      folderSection(ctx),
      projectViewSection(ctx),
      projectDestructiveSection(ctx),
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
