import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectConfig, Session, SessionRuntime } from '../../shared/types'
import { findProject, groupKey, runtimeLabel, sameRuntime } from '../../shared/wsl-path'
import { RuntimeChip } from './RuntimeChip'
import { C, STATUS_COLORS, STATUS_LABELS, accentA, ink, dotStyle, statusMark, sz } from '../theme'
import { Icon, type IconName } from '../icons'
import { runProjectTask, stopProjectTask } from '../menus'
import { SESSION_MIME } from './SplitDropOverlay'
import {
  type MenuTarget,
  type ProjectGroup,
  type SidebarRow,
  branchKey,
  buildGroups,
  canReorderOnto,
  buildRows,
  shortcutSlots,
  useStore,
} from '../state/store'
import { SESSION_DIGIT_LABEL, sessionDigitMod } from '../shortcuts'

const HEADER_BTN_HOVER = ink(0.06)

const headerBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: sz(22),
  height: sz(22),
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: C.muted,
  cursor: 'pointer',
  padding: 0,
  flex: 'none',
}

const menuInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 9px',
  background: C.input,
  border: `1px solid ${C.border2}`,
  borderRadius: 7,
  color: C.textHi,
  font: 'inherit',
  fontSize: 12,
  outline: 'none',
  boxSizing: 'border-box',
}

/** Id of the session row currently being dragged (sidebar reorder). */
let draggedId: string | null = null

/**
 * Open a context menu from a right-click. Right-click never fires `click` and
 * never starts an HTML5 drag, so this is purely additive — opening on left-click
 * and drag-to-reorder are untouched. Falls back to the element's own box for a
 * keyboard-invoked menu (Shift+F10), where the coordinates are 0.
 */
function menuOpener(target: MenuTarget) {
  return (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const { clientX, clientY } = e
    const r = e.currentTarget.getBoundingClientRect()
    const at = clientX || clientY ? { x: clientX, y: clientY } : { x: r.left + 8, y: r.bottom }
    useStore.getState().openContextMenu({ target, ...at })
  }
}

/**
 * Whether Alt is down. The shortcut numbers ride on this: they sit faint at rest,
 * where they are a reference and not a control, and lift to the accent while the
 * modifier that uses them is actually held.
 *
 * Capture phase, and strictly passive — no preventDefault, no stopPropagation —
 * so it sees the modifier even while a terminal has focus without disturbing
 * App's Alt+digit handler or Alt reaching the PTY. Blur and visibilitychange
 * clear it because Alt+Tab takes the window away without ever delivering the
 * keyup, which would otherwise leave the sidebar lit.
 */
function useAltHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    // The handler's own modifier alone (Alt, or Cmd on macOS) — Ctrl+Alt+3 switches
    // nothing, so it has no business lighting the numbers up.
    const onKey = (e: KeyboardEvent) => setHeld(sessionDigitMod(e))
    const clear = () => setHeld(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('blur', clear)
    document.addEventListener('visibilitychange', clear)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('blur', clear)
      document.removeEventListener('visibilitychange', clear)
    }
  }, [])
  return held
}

/**
 * The Alt+N that switches to this session, at the row's right edge. Always in
 * layout, digit or not: the right edge is the one place that doesn't move with
 * branch indentation, so a fixed slot there keeps every number in one readable
 * column, and a session past the ninth leaves a blank rather than nudging its
 * neighbours' digits sideways.
 */
function ShortcutSlot({ slot, altHeld }: { slot?: number; altHeld: boolean }): React.JSX.Element {
  return (
    <span
      title={slot ? `${SESSION_DIGIT_LABEL}${slot}` : undefined}
      style={{
        width: sz(10),
        flex: 'none',
        textAlign: 'right',
        fontSize: 10.5,
        lineHeight: 1,
        color: altHeld ? C.accent : C.faint2,
        transition: 'color 0.12s ease',
      }}
    >
      {slot ?? ''}
    </span>
  )
}

function activityColor(s: Session): string {
  if (s.status === 'waiting') return C.accentSoft
  if (s.status === 'error') return C.danger
  return C.muted
}

const KIND_ICONS: Partial<Record<Session['kind'], IconName>> = {
  shell: 'terminal',
  editor: 'editor',
  browser: 'globe',
  pdf: 'pdf',
}

/**
 * A session's drag, for the sidebar row and the top bar's tab alike. Two
 * audiences. The MIME type is for the panes: `getData` is sealed during
 * dragover, but `types` is readable, so this is the only way a drop target can
 * tell a session drag from a file drag before the drop. The store field is for
 * the drop overlay, which has to *mount* when the drag starts. Reordering among
 * the session's siblings uses `draggedId`.
 */
function useSessionDrag(session: Session, editing: boolean) {
  const reorderWithinGroup = useStore((s) => s.reorderWithinGroup)
  const [dragOver, setDragOver] = useState(false)

  // Drag-reorder: only offer a drop where the order stays meaningful — same
  // project group, same place in the branch tree.
  const canDropHere = (): boolean => {
    if (!draggedId || draggedId === session.id) return false
    const dragged = useStore.getState().sessions[draggedId]
    return !!dragged && canReorderOnto(dragged, session)
  }

  const dragProps = {
    // A draggable ancestor swallows drag-to-select inside a nested input, so
    // the session stops being draggable while its name is being edited.
    draggable: !editing,
    onDragStart: (e: React.DragEvent) => {
      draggedId = session.id
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(SESSION_MIME, session.id)
      useStore.getState().setDraggingSession(session.id)
    },
    onDragEnd: () => {
      draggedId = null
      setDragOver(false)
      useStore.getState().setDraggingSession(null)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!canDropHere()) return
      e.preventDefault()
      if (!dragOver) setDragOver(true)
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (draggedId) reorderWithinGroup(draggedId, session.id)
      draggedId = null
    },
  }
  return { dragOver, dragProps }
}

/** The box a session's name turns into while it is being renamed. */
function RenameField({ session, width }: { session: Session; width?: number }): React.JSX.Element {
  const startEdit = useStore((s) => s.startEdit)
  const nameRef = useRef<HTMLInputElement>(null)

  const commitRename = () => {
    const v = nameRef.current?.value.trim()
    if (v) void window.terminator.renameSession(session.id, v)
    startEdit(null)
  }

  return (
    <input
      ref={nameRef}
      defaultValue={session.name}
      autoFocus
      // The row's own onClick calls openSession, which clears editingId —
      // a single click inside the box would otherwise destroy it.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={commitRename}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commitRename()
        else if (e.key === 'Escape') {
          e.stopPropagation() // cancelling the rename is all this Esc does
          startEdit(null)
        }
      }}
      style={{
        ...(width ? { width, flex: 'none' } : { minWidth: 0, flex: 1 }),
        background: ink(0.06),
        border: `1px solid ${accentA(0.45)}`,
        borderRadius: 4,
        color: C.textMax,
        font: 'inherit',
        fontSize: 12.5,
        fontWeight: 500,
        padding: '1px 5px',
        outline: 'none',
      }}
    />
  )
}

/**
 * One session line. Branches are indented under the session they were forked
 * from, and a session with branches carries a count badge that folds them away —
 * while still flagging a hidden branch that needs attention.
 */
function Row({
  row,
  slot,
  altHeld,
}: {
  row: SidebarRow
  slot?: number
  altHeld: boolean
}): React.JSX.Element {
  const { session, depth, branches, collapsed, hiddenNotified } = row
  const shown = useStore((s) => s.panes.includes(session.id))
  const focusedId = useStore((s) => s.panes[s.focused])
  const openSession = useStore((s) => s.openSession)
  const setConfirm = useStore((s) => s.setConfirm)
  const toggleGroup = useStore((s) => s.toggleGroup)
  // `editingId` is global, so the surface has to match too — otherwise a session
  // open in a pane *and* visible here would render two autofocused inputs.
  const editing = useStore((s) => s.editingId === session.id && s.editingWhere === 'sidebar')
  // A boolean, not a derived object: a fresh object from a selector would loop
  // useSyncExternalStore.
  const menuOpen = useStore(
    (s) => s.contextMenu?.target.kind === 'sessions' && s.contextMenu.target.ids.includes(session.id),
  )
  const { dragOver, dragProps } = useSessionDrag(session, editing)
  const active = focusedId === session.id
  const kindIcon = KIND_ICONS[session.kind]
  // The accent "selected" treatment is reserved for the single focused session.
  // A notified (needs-attention) session is signalled separately by the pulsing
  // dot below, so it never competes with selection when several are notified.

  const iconBtn = (extra?: React.CSSProperties): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: sz(18),
    height: sz(18),
    borderRadius: 4,
    border: 'none',
    background: 'transparent',
    color: C.muted,
    cursor: 'pointer',
    padding: 0,
    flex: 'none',
    ...extra,
  })

  return (
    <div
      className="cc-row"
      {...dragProps}
      onClick={() => openSession(session.id)}
      onContextMenu={
        editing
          ? undefined // leave the rename input its native menu, for paste
          : menuOpener({ kind: 'sessions', ids: [session.id] })
      }
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 8px',
        paddingLeft: 8 + depth * 12,
        borderRadius: 7,
        cursor: 'pointer',
        background: active
          ? C.rowActive
          : menuOpen
            ? ink(0.06)
            : shown
              ? ink(0.04)
              : 'transparent',
        // The accent treatment stays reserved for the one focused session, so a
        // row with its menu open is marked with a neutral hairline instead.
        border: `1px solid ${active ? C.rowActiveBorder : menuOpen ? C.border3 : 'transparent'}`,
        boxShadow: dragOver ? `inset 0 2px 0 ${C.accent}` : undefined,
      }}
    >
      {depth > 0 && (
        <span
          title={session.branchedFrom ? `branched from ${session.branchedFrom}` : 'branch'}
          style={{ display: 'flex', color: C.faint2, flex: 'none', marginRight: -4 }}
        >
          <Icon name="branch" size={11} />
        </span>
      )}
      <span style={dotStyle(session.status, 9)} />
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {kindIcon && (
            <span style={{ display: 'flex', color: C.kindIcon, flex: 'none' }}>
              <Icon name={kindIcon} size={12} />
            </span>
          )}
          {editing ? (
            <RenameField session={session} />
          ) : (
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 500,
                color: active ? C.textHi : C.text,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {session.name}
            </span>
          )}
          {session.kind === 'claude' && session.mode === 'readonly' && (
            <span style={{ display: 'flex', color: C.muted, flex: 'none' }}>
              <Icon name="lock" size={11} />
            </span>
          )}
          <RuntimeChip runtime={session.runtime} />
          {session.notified && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: C.accent,
                flex: 'none',
                marginLeft: 'auto',
                animation: 'cc-notif 1.2s ease-in-out infinite',
              }}
            />
          )}
        </div>
        <span
          style={{
            fontSize: 10.5,
            color: activityColor(session),
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {session.activity}
        </span>
      </div>
      {branches > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            toggleGroup(branchKey(session.id))
          }}
          title={
            collapsed
              ? `Show ${branches} branch${branches > 1 ? 'es' : ''}${hiddenNotified ? ' — one needs your input' : ''}`
              : `Hide ${branches} branch${branches > 1 ? 'es' : ''}`
          }
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            padding: '2px 5px',
            borderRadius: 5,
            border: 'none',
            background: collapsed ? ink(0.06) : 'transparent',
            color: hiddenNotified ? C.accent : C.muted,
            font: 'inherit',
            fontSize: 10,
            cursor: 'pointer',
            flex: 'none',
            animation: hiddenNotified ? 'cc-notif 1.2s ease-in-out infinite' : undefined,
          }}
        >
          <Icon name="branch" size={11} />
          {branches}
        </button>
      )}
      <button
        className="cc-x"
        onClick={(e) => {
          e.stopPropagation()
          setConfirm({ kind: 'remove', id: session.id, name: session.name })
        }}
        title="Remove session"
        style={iconBtn()}
      >
        <Icon name="close" size={13} />
      </button>
      <ShortcutSlot slot={slot} altHeld={altHeld} />
    </div>
  )
}

/**
 * A session in the collapsed rail: a status-coloured mark (the "which session needs
 * me" signal). The accent "selected" ring is reserved for the single focused
 * session; a notified session is flagged by a distinct corner badge instead, so
 * several notified tabs never read as several selected ones.
 *
 * Within Alt's reach the mark is the shortcut digit itself, in the status colour
 * and wearing the dot's own animation — the rail has no room for both, and a
 * number you can read beats a shape you can't name. Past the ninth session there
 * is no key to print, so those tabs keep the dot. Holding Alt washes the reachable
 * tabs in accent and thickens their digits: the rail arms without ever recolouring
 * a digit away from its status, which is what you are reading as you choose.
 *
 * A tab drags onto the panes exactly as a Row does, so collapsing the sidebar
 * doesn't cost you the ability to arrange splits. It is only a drag *source*,
 * though: Row's other drag, reordering within a project group, has no meaning
 * here, where the rail flattens every group into one column.
 */
function RailTab({
  session,
  slot,
  altHeld,
}: {
  session: Session
  slot?: number
  altHeld: boolean
}): React.JSX.Element {
  const focusedId = useStore((s) => s.panes[s.focused])
  const shown = useStore((s) => s.panes.includes(session.id))
  const openSession = useStore((s) => s.openSession)
  const menuOpen = useStore(
    (s) => s.contextMenu?.target.kind === 'sessions' && s.contextMenu.target.ids.includes(session.id),
  )
  const active = focusedId === session.id
  const notified = session.notified && !active
  const armed = altHeld && slot !== undefined
  const hint = slot ? `  (${SESSION_DIGIT_LABEL}${slot})` : ''

  return (
    <button
      data-rail-session={session.id}
      draggable
      onClick={() => openSession(session.id)}
      onContextMenu={menuOpener({ kind: 'sessions', ids: [session.id] })}
      onDragStart={(e) => {
        // The same two audiences Row's drag start serves: the MIME type tells a
        // pane this is a session and not a file, and the store field is what
        // mounts the drop overlay. `draggedId` stays untouched — that one is the
        // sidebar's reorder, which the rail doesn't offer.
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(SESSION_MIME, session.id)
        useStore.getState().setDraggingSession(session.id)
      }}
      onDragEnd={() => useStore.getState().setDraggingSession(null)}
      title={`${session.name} · ${STATUS_LABELS[session.status]}${hint}`}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: sz(30),
        height: sz(30),
        borderRadius: 8,
        flex: 'none',
        cursor: 'pointer',
        padding: 0,
        font: 'inherit',
        background: active
          ? C.rowActive
          : armed
            ? accentA(0.07)
            : menuOpen
              ? ink(0.06)
              : shown
                ? ink(0.04)
                : 'transparent',
        border: `1px solid ${
          active ? C.rowActiveBorder : armed ? accentA(0.14) : menuOpen ? C.border3 : 'transparent'
        }`,
        transition: 'background 0.12s ease, border-color 0.12s ease',
      }}
    >
      {slot === undefined ? (
        <span style={dotStyle(session.status, 11)} />
      ) : (
        // A rounded box, not a bare glyph: `cc-pulse` draws the waiting ring with a
        // box-shadow, and it has to come off something round to read as a halo.
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: sz(18),
            height: sz(18),
            borderRadius: 6,
            fontSize: 12.5,
            fontWeight: armed ? 700 : 600,
            lineHeight: 1,
            color: STATUS_COLORS[session.status],
            ...statusMark(session.status),
          }}
        >
          {slot}
        </span>
      )}
      {notified && (
        <span
          style={{
            position: 'absolute',
            top: 3,
            right: 3,
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: C.accent,
            border: `1px solid ${C.sidebar}`,
            animation: 'cc-notif 1.2s ease-in-out infinite',
          }}
        />
      )}
    </button>
  )
}

/**
 * The line above a group's dots in the collapsed rail — and, for want of
 * anywhere else to put it, the group itself.
 *
 * The rail has no header to right-click: it flattens every group into one column
 * of dots, so the separator that already says "a new project starts here" is the
 * only thing on screen that means the group. It carries the project menu rather
 * than a label chip, which a 42px rail has no room for. The hairline stays 1px;
 * the button around it is what your pointer actually has to hit, and the title
 * is what tells you there is anything to hit at all.
 *
 * A real button, not a styled span, so it takes focus: menuOpener already falls
 * back to the element's own box for a keyboard-invoked menu, which is what makes
 * a group reachable here without a pointer. There is no left-click action — the
 * menu is the whole point, and the rail deliberately keeps every dot visible
 * (the "needs me" signal is why it exists), so collapsing has nothing to show.
 */
function RailGroupDivider({ group }: { group: ProjectGroup }): React.JSX.Element {
  const menuOpen = useStore(
    (s) =>
      s.contextMenu?.target.kind === 'project' &&
      groupKey({ projectName: s.contextMenu.target.name, runtime: s.contextMenu.target.runtime }) === group.key,
  )
  const [hover, setHover] = useState(false)
  const n = group.sessions.length
  const lit = hover || menuOpen
  return (
    <button
      onContextMenu={menuOpener({
        kind: 'project',
        name: group.name,
        path: group.sessions[0]?.projectPath ?? '',
        runtime: group.runtime,
      })}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${group.name}${group.runtime ? ` (${runtimeLabel(group.runtime)})` : ''} · ${n} session${n === 1 ? '' : 's'} — right-click for the project menu`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: sz(24),
        height: 11,
        padding: 0,
        border: 'none',
        background: 'transparent',
        flex: 'none',
        cursor: 'default',
      }}
    >
      {/* Resting weight and width are what made these breaks readable in the
          first place: the rail has no project headers, so this line is the only
          structure in it and is deliberately heavier than a C.hair rule. Lit
          while hovered or while its own menu is open — in a rail with no labels
          that is the only way to see which group you just hit. */}
      <span
        style={{
          width: lit ? 26 : 22,
          height: 1,
          borderRadius: 1,
          background: ink(lit ? 0.34 : 0.18),
          transition: 'width 0.12s ease, background 0.12s ease',
        }}
      />
    </button>
  )
}

/**
 * Popover to set a project's Build/Run/Stop commands. Prefilled from the current
 * config; Save writes the whole `projects` array back through updateSettings (its
 * `merge` replaces `projects` wholesale, so every command must be written each time).
 * Anchored to the group header's button cluster, or at `at` in the window when given.
 */
function ProjectCommandsMenu({
  projectName,
  projectPath,
  runtime,
  proj,
  at,
  onClose,
}: {
  projectName: string
  projectPath: string
  /** Where the project lives — the same path in WSL and on Windows is two projects. */
  runtime?: SessionRuntime
  proj?: ProjectConfig
  at?: { top: number; left: number }
  onClose: () => void
}): React.JSX.Element {
  const setSettings = useStore((s) => s.setSettings)
  const [build, setBuild] = useState(proj?.buildCommand ?? '')
  const [run, setRun] = useState(proj?.runCommand ?? '')
  const [stop, setStop] = useState(proj?.stopCommand ?? '')

  const save = async () => {
    const settings = useStore.getState().settings
    if (!settings) return
    const buildCommand = build.trim()
    const runCommand = run.trim()
    const stopCommand = stop.trim()
    const same = (p: ProjectConfig) => p.path === projectPath && sameRuntime(p.runtime, runtime)
    const exists = settings.projects.some(same)
    const projects = exists
      ? settings.projects.map((p) => (same(p) ? { ...p, buildCommand, runCommand, stopCommand } : p))
      : [
          ...settings.projects,
          {
            name: projectName,
            path: projectPath,
            ...(runtime ? { runtime } : {}),
            buildCommand,
            runCommand,
            stopCommand,
          },
        ]
    const result = await window.terminator.updateSettings({ projects })
    setSettings(result)
    onClose()
  }

  return (
    <>
      <div
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        style={{ position: 'fixed', inset: 0, zIndex: 30 }}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          ...(at ? { position: 'fixed', ...at } : { position: 'absolute', top: 26, right: 0 }),
          zIndex: 31,
          width: 236,
          padding: 12,
          background: C.panel,
          border: `1px solid ${C.border3}`,
          borderRadius: 10,
          boxShadow: C.shadowMenu,
          animation: 'cc-fade 0.12s ease',
          cursor: 'default',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: C.textHi,
            marginBottom: 10,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {projectName} · commands
        </div>
        <div style={{ fontSize: 10, letterSpacing: 0.5, color: C.muted, fontWeight: 600, marginBottom: 5 }}>BUILD</div>
        <input
          autoFocus
          value={build}
          onChange={(e) => setBuild(e.target.value)}
          placeholder="npm run build"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            else if (e.key === 'Escape') onClose()
          }}
          style={menuInputStyle}
        />
        <div style={{ fontSize: 10, letterSpacing: 0.5, color: C.muted, fontWeight: 600, margin: '10px 0 5px' }}>RUN</div>
        <input
          value={run}
          onChange={(e) => setRun(e.target.value)}
          placeholder="npm run dev"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            else if (e.key === 'Escape') onClose()
          }}
          style={menuInputStyle}
        />
        <div style={{ fontSize: 10, letterSpacing: 0.5, color: C.muted, fontWeight: 600, margin: '10px 0 5px' }}>STOP</div>
        <input
          value={stop}
          onChange={(e) => setStop(e.target.value)}
          placeholder="npm run stop"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            else if (e.key === 'Escape') onClose()
          }}
          style={menuInputStyle}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button
            onClick={onClose}
            style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border3}`, borderRadius: 7, color: C.textBtn, font: 'inherit', fontSize: 12, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            style={{ padding: '6px 14px', background: C.accent, border: 'none', borderRadius: 7, color: C.accentText, font: 'inherit', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
          >
            Save
          </button>
        </div>
      </div>
    </>
  )
}

/**
 * A project's Build/Run buttons and a gear that opens the command editor. Build/Run
 * reuse one dedicated interactive terminal per project + task, created inside this
 * group; later clicks retype the command at its prompt. Stop has no terminal of its
 * own — it types the stop command into the Run terminal, so it only appears once
 * that terminal exists (i.e. after Run has been clicked).
 *
 * `fixedMenu` opens the editor at a fixed spot under the buttons rather than inside
 * them, for the top bar, whose scrolling strip would clip it.
 */
function GroupActions({ group, fixedMenu }: { group: ProjectGroup; fixedMenu?: boolean }): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuAt, setMenuAt] = useState<{ top: number; left: number }>()
  const clusterRef = useRef<HTMLDivElement>(null)

  const projectPath = group.sessions[0]?.projectPath ?? ''
  const proj = settings ? findProject(settings.projects, projectPath, group.runtime) : undefined
  const buildCmd = proj?.buildCommand?.trim()
  const runCmd = proj?.runCommand?.trim()
  const stopCmd = proj?.stopCommand?.trim()
  // From `group.sessions` (not the store snapshot) so the Stop button appears the
  // moment Run creates the terminal and vanishes when it is closed.
  const runSession = group.sessions.find((s) => s.task === 'run' && s.projectPath === projectPath)

  // Both live in menus.ts so the header buttons and the group's context menu run
  // exactly one implementation.
  const runTask = (task: 'build' | 'run') =>
    runProjectTask({ name: group.name, path: projectPath, runtime: group.runtime }, task)

  const stopTask = async () => {
    if (!runSession) return
    await stopProjectTask(runSession.id)
  }

  const headerBtn = (
    icon: IconName,
    title: string,
    enabled: boolean,
    onClick: () => void,
  ): React.JSX.Element => (
    <button
      onClick={(e) => {
        e.stopPropagation()
        if (enabled) onClick()
      }}
      title={title}
      style={{ ...headerBtnStyle, opacity: enabled ? 1 : 0.3, cursor: enabled ? 'pointer' : 'default' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = HEADER_BTN_HOVER)}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <Icon name={icon} size={13} />
    </button>
  )

  const taskBtn = (task: 'build' | 'run', enabled: boolean): React.JSX.Element =>
    headerBtn(
      task === 'build' ? 'hammer' : 'play',
      enabled ? (task === 'build' ? 'Build' : 'Run') : `Set a ${task} command — click the gear`,
      enabled,
      () => void runTask(task),
    )

  return (
    <div
      ref={clusterRef}
      onClick={(e) => e.stopPropagation()}
      style={{ display: 'flex', alignItems: 'center', gap: 1, position: 'relative', flex: 'none' }}
    >
      {taskBtn('build', !!buildCmd)}
      {taskBtn('run', !!runCmd)}
      {runSession &&
        headerBtn(
          'stop',
          stopCmd ? 'Stop' : 'Set a stop command — click the gear',
          !!stopCmd,
          () => void stopTask(),
        )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          const r = clusterRef.current?.getBoundingClientRect()
          // 244 = the editor's width plus a margin, so it never runs off the right edge.
          if (fixedMenu && r) setMenuAt({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 244) })
          setMenuOpen((v) => !v)
        }}
        title="Set Build / Run / Stop commands for this project"
        style={{ ...headerBtnStyle, background: menuOpen ? HEADER_BTN_HOVER : 'transparent' }}
        onMouseEnter={(e) => (e.currentTarget.style.background = HEADER_BTN_HOVER)}
        onMouseLeave={(e) => (e.currentTarget.style.background = menuOpen ? HEADER_BTN_HOVER : 'transparent')}
      >
        <Icon name="settings" size={13} />
      </button>
      {menuOpen && (
        <ProjectCommandsMenu
          projectName={group.name}
          projectPath={projectPath}
          runtime={group.runtime}
          proj={proj}
          at={menuAt}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * One project group: a collapsible header (name + session count) carrying this
 * project's GroupActions, followed by its session rows.
 */
function Group({
  group,
  slots,
  altHeld,
}: {
  group: ProjectGroup
  slots: Map<string, number>
  altHeld: boolean
}): React.JSX.Element {
  const isCollapsed = useStore((s) => !!s.collapsed[group.key])
  const collapsedMap = useStore((s) => s.collapsed)
  const toggleGroup = useStore((s) => s.toggleGroup)
  const projectPath = group.sessions[0]?.projectPath ?? ''

  return (
    <div>
      <div
        onClick={() => toggleGroup(group.key)}
        onContextMenu={menuOpener({ kind: 'project', name: group.name, path: projectPath, runtime: group.runtime })}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '13px 4px 6px', cursor: 'pointer' }}
      >
        <span
          style={{
            display: 'flex',
            color: C.muted,
            transform: isCollapsed ? 'rotate(-90deg)' : 'none',
            transition: 'transform 0.12s ease',
          }}
        >
          <Icon name="chevron" size={12} />
        </span>
        <span
          style={{
            fontSize: 10.5,
            letterSpacing: 0.6,
            color: C.dim,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {group.name}
        </span>
        <RuntimeChip runtime={group.runtime} />
        <span style={{ fontSize: 10, color: C.faint2 }}>{group.sessions.length}</span>
        <span style={{ flex: 1, height: 1, background: C.hair, minWidth: 8 }} />
        <GroupActions group={group} />
      </div>
      {!isCollapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {buildRows(group, collapsedMap).map((r) => (
            <Row key={r.session.id} row={r} slot={slots.get(r.session.id)} altHeld={altHeld} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A session in the top bar: the sidebar row laid on its side. The line a row
 * shows under the name — the activity — goes into the tooltip, since a tab has
 * no room for a second line; everything else (status dot, kind, rename, remove,
 * the Alt+N digit, both drags) is the row's. A branch can't be indented in a
 * strip, but it already follows its parent, and keeps the branch mark.
 */
function TopTab({
  session,
  branch,
  slot,
  altHeld,
}: {
  session: Session
  branch: boolean
  slot?: number
  altHeld: boolean
}): React.JSX.Element {
  const shown = useStore((s) => s.panes.includes(session.id))
  const focusedId = useStore((s) => s.panes[s.focused])
  const openSession = useStore((s) => s.openSession)
  const setConfirm = useStore((s) => s.setConfirm)
  // The rename the context menu starts on the 'sidebar' surface lands here.
  const editing = useStore((s) => s.editingId === session.id && s.editingWhere === 'sidebar')
  const menuOpen = useStore(
    (s) => s.contextMenu?.target.kind === 'sessions' && s.contextMenu.target.ids.includes(session.id),
  )
  const { dragOver, dragProps } = useSessionDrag(session, editing)
  const ref = useRef<HTMLDivElement>(null)
  const active = focusedId === session.id
  const kindIcon = KIND_ICONS[session.kind]
  const hint = slot ? `  (${SESSION_DIGIT_LABEL}${slot})` : ''

  // Alt+N and Alt+Up/Down can switch to a tab scrolled out of the strip.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  return (
    <div
      ref={ref}
      className="cc-row"
      {...dragProps}
      onClick={() => openSession(session.id)}
      onContextMenu={editing ? undefined : menuOpener({ kind: 'sessions', ids: [session.id] })}
      title={`${session.name} · ${session.activity || STATUS_LABELS[session.status]}${hint}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        maxWidth: 220,
        padding: '5px 6px 5px 9px',
        borderRadius: 7,
        flex: 'none',
        cursor: 'pointer',
        background: active ? C.rowActive : menuOpen ? ink(0.06) : shown ? ink(0.04) : 'transparent',
        border: `1px solid ${active ? C.rowActiveBorder : menuOpen ? C.border3 : 'transparent'}`,
        boxShadow: dragOver ? `inset 2px 0 0 ${C.accent}` : undefined,
      }}
    >
      {branch && (
        <span style={{ display: 'flex', color: C.faint2, flex: 'none', marginRight: -3 }}>
          <Icon name="branch" size={11} />
        </span>
      )}
      <span style={dotStyle(session.status, 8)} />
      {kindIcon && (
        <span style={{ display: 'flex', color: C.kindIcon, flex: 'none' }}>
          <Icon name={kindIcon} size={12} />
        </span>
      )}
      {editing ? (
        <RenameField session={session} width={140} />
      ) : (
        <span
          style={{
            minWidth: 0,
            fontSize: 12.5,
            fontWeight: 500,
            color: active ? C.textHi : C.text,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {session.name}
        </span>
      )}
      {session.kind === 'claude' && session.mode === 'readonly' && (
        <span style={{ display: 'flex', color: C.muted, flex: 'none' }}>
          <Icon name="lock" size={11} />
        </span>
      )}
      <RuntimeChip runtime={session.runtime} />
      {session.notified && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: C.accent,
            flex: 'none',
            animation: 'cc-notif 1.2s ease-in-out infinite',
          }}
        />
      )}
      <button
        className="cc-x"
        onClick={(e) => {
          e.stopPropagation()
          setConfirm({ kind: 'remove', id: session.id, name: session.name })
        }}
        title="Remove session"
        style={{ ...headerBtnStyle, width: sz(18), height: sz(18), borderRadius: 4 }}
      >
        <Icon name="close" size={12} />
      </button>
      <ShortcutSlot slot={slot} altHeld={altHeld} />
    </div>
  )
}

/**
 * One project group in the top bar: a header chip, then its tabs. The chip does
 * what the sidebar's group header does — click folds, right-click opens the
 * project menu — and shows the group's buttons only while hovered, which a strip
 * can't spare the room to keep out. A folded group doesn't disappear: its tabs
 * shrink to the rail's status marks, so the "needs me" signal stays on screen and
 * Alt+Up/Down still reaches every session.
 */
function TopGroup({
  group,
  slots,
  altHeld,
}: {
  group: ProjectGroup
  slots: Map<string, number>
  altHeld: boolean
}): React.JSX.Element {
  const isCollapsed = useStore((s) => !!s.collapsed[group.key])
  const toggleGroup = useStore((s) => s.toggleGroup)
  const projectPath = group.sessions[0]?.projectPath ?? ''
  const n = group.sessions.length

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, flex: 'none' }}>
      <div
        className="cc-tgroup"
        onClick={() => toggleGroup(group.key)}
        onContextMenu={menuOpener({ kind: 'project', name: group.name, path: projectPath, runtime: group.runtime })}
        style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 4px 0 2px', cursor: 'pointer', flex: 'none' }}
      >
        <span
          style={{
            display: 'flex',
            color: C.muted,
            transform: isCollapsed ? 'rotate(-90deg)' : 'none',
            transition: 'transform 0.12s ease',
          }}
        >
          <Icon name="chevron" size={12} />
        </span>
        {/* The title sits here, not on the chip: the commands editor opens inside
            the chip and would otherwise wear it as a tooltip. */}
        <span
          title={`${group.name} · ${n} session${n === 1 ? '' : 's'} — right-click for the project menu`}
          style={{
            maxWidth: 140,
            fontSize: 10.5,
            letterSpacing: 0.6,
            color: C.dim,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {group.name}
        </span>
        <RuntimeChip runtime={group.runtime} />
        <span style={{ fontSize: 10, color: C.faint2 }}>{n}</span>
        <span className="cc-tgroup-actions">
          <GroupActions group={group} fixedMenu />
        </span>
      </div>
      {group.sessions.map((s) =>
        isCollapsed ? (
          <RailTab key={s.id} session={s} slot={slots.get(s.id)} altHeld={altHeld} />
        ) : (
          <TopTab key={s.id} session={s} branch={!!group.depth[s.id]} slot={slots.get(s.id)} altHeld={altHeld} />
        ),
      )}
    </div>
  )
}

/**
 * The session list as a strip across the top of the window (`sidebarSide: 'top'`):
 * New session, every project group's tabs in the sidebar's order, then Notes and
 * Settings. It has no collapsed form — it takes no width from the panes, so there
 * is nothing to win by hiding it — and scrolls sideways once the tabs outgrow it.
 */
function TopBar({
  groups,
  slots,
  altHeld,
}: {
  groups: ProjectGroup[]
  slots: Map<string, number>
  altHeld: boolean
}): React.JSX.Element {
  const setShowNew = useStore((s) => s.setShowNew)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setShowNotes = useStore((s) => s.setShowNotes)

  const btn: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: sz(28),
    height: sz(28),
    borderRadius: 7,
    border: `1px solid ${C.border2}`,
    background: 'transparent',
    color: C.textSubtle,
    cursor: 'pointer',
    padding: 0,
    flex: 'none',
  }

  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '5px 10px',
        background: C.sidebar,
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      <button
        onClick={() => setShowNew(true)}
        title="New session (⌘N)"
        style={{ ...btn, background: C.accentBg, border: `1px solid ${C.accentBorder}`, color: C.accent }}
      >
        <Icon name="plus" size={16} />
      </button>
      <div
        className="cc-topbar-tabs"
        // A mouse wheel only scrolls up and down, and the strip has nowhere to go
        // but sideways. A trackpad's own sideways swipe comes through untouched.
        onWheel={(e) => {
          if (!e.deltaX) e.currentTarget.scrollLeft += e.deltaY
        }}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          overflowX: 'auto',
          overflowY: 'hidden',
        }}
      >
        {groups.length === 0 && (
          <span style={{ fontSize: 11.5, color: C.dim, whiteSpace: 'nowrap' }}>
            No sessions yet. Create one to get started.
          </span>
        )}
        {groups.map((g, i) => (
          <Fragment key={g.key}>
            {i > 0 && <span style={{ width: 1, height: 18, background: C.border2, flex: 'none' }} />}
            <TopGroup group={g} slots={slots} altHeld={altHeld} />
          </Fragment>
        ))}
      </div>
      <button onClick={() => setShowNotes(true)} title="Notes" style={btn}>
        <Icon name="note" size={15} />
      </button>
      <button onClick={() => setShowSettings(true)} title="Settings" style={btn}>
        <Icon name="settings" size={15} />
      </button>
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const groups = useMemo(() => buildGroups(order, sessions), [order, sessions])
  // Keyed by id, from the same slots the Alt+1..9 handler walks — a session
  // hidden under a folded branch still holds its number, so the rows on screen
  // can read 1, 2, 5, 6 and every one of them is the key that actually fires.
  const slots = useMemo(() => {
    const m = new Map<string, number>()
    shortcutSlots(groups).forEach((id, i) => m.set(id, i + 1))
    return m
  }, [groups])
  const altHeld = useAltHeld()
  const total = order.length
  const setShowNew = useStore((s) => s.setShowNew)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setShowNotes = useStore((s) => s.setShowNotes)
  const hidden = useStore((s) => s.sidebarHidden)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const sidebarSide = useStore((s) => s.settings?.sidebarSide ?? 'left')

  if (sidebarSide === 'top') return <TopBar groups={groups} slots={slots} altHeld={altHeld} />

  // The divider sits between the sidebar and the panes, so it flips with the side.
  const sideBorder: React.CSSProperties =
    sidebarSide === 'right'
      ? { borderLeft: `1px solid ${C.border}` }
      : { borderRight: `1px solid ${C.border}` }

  const railBtn: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: sz(28),
    height: sz(28),
    borderRadius: 7,
    border: `1px solid ${C.border2}`,
    background: 'transparent',
    color: C.textSubtle,
    cursor: 'pointer',
  }

  // Collapsed: a slim rail with expand + new-session and the session tabs as status
  // dots, so the "needs me" signal and session switching survive collapsing.
  if (hidden) {
    // Flatten to the same grouped order the expanded sidebar (and Alt+1..9) use,
    // hanging each group off its first tab so the line above that tab can be the
    // group's handle. Every group gets one, the first included — it draws the
    // line that used to sit outside the list, and it is the only way to reach a
    // project menu while the sidebar is collapsed.
    const railItems = groups.flatMap((g) =>
      g.sessions.map((s, si) => ({ session: s, group: si === 0 ? g : null })),
    )
    return (
      <div
        style={{
          width: sz(42),
          flex: 'none',
          background: C.sidebar,
          ...sideBorder,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 14,
          gap: 8,
        }}
      >
        <button
          onClick={toggleSidebar}
          // Notes and Settings are header buttons the rail doesn't render, so
          // while collapsed this is the way to them. Hung off the sidebar button
          // because it's the one control here that isn't about a session.
          onContextMenu={menuOpener({ kind: 'app' })}
          title="Show sidebar (Ctrl/⌘B) · right-click for Notes and Settings"
          style={railBtn}
        >
          <Icon name="sidebar" size={16} />
        </button>
        <button
          onClick={() => setShowNew(true)}
          title="New session (⌘N)"
          style={{ ...railBtn, background: C.accentBg, border: `1px solid ${C.accentBorder}`, color: C.accent }}
        >
          <Icon name="plus" size={16} />
        </button>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            width: '100%',
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            paddingBottom: 10,
          }}
        >
          {railItems.map((it) => (
            <Fragment key={it.session.id}>
              {it.group && <RailGroupDivider group={it.group} />}
              <RailTab session={it.session} slot={slots.get(it.session.id)} altHeld={altHeld} />
            </Fragment>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        width: 262,
        flex: 'none',
        background: C.sidebar,
        ...sideBorder,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ padding: '16px 14px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 13, padding: '0 2px' }}>
          <span style={{ fontSize: 11, letterSpacing: 1.5, color: C.muted, fontWeight: 600 }}>SESSIONS</span>
          <span style={{ fontSize: 11, color: C.faint }}>{total}</span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => setShowNotes(true)}
            title="Notes"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: sz(26),
              height: sz(26),
              borderRadius: 6,
              border: `1px solid ${C.border2}`,
              background: 'transparent',
              color: C.textSubtle,
              cursor: 'pointer',
              marginRight: 6,
            }}
          >
            <Icon name="note" size={15} />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: sz(26),
              height: sz(26),
              borderRadius: 6,
              border: `1px solid ${C.border2}`,
              background: 'transparent',
              color: C.textSubtle,
              cursor: 'pointer',
              marginRight: 6,
            }}
          >
            <Icon name="settings" size={15} />
          </button>
          <button
            onClick={toggleSidebar}
            title="Hide sidebar (Ctrl/⌘B)"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: sz(26),
              height: sz(26),
              borderRadius: 6,
              border: `1px solid ${C.border2}`,
              background: 'transparent',
              color: C.textSubtle,
              cursor: 'pointer',
              marginLeft: 6,
            }}
          >
            <Icon name="sidebar" size={15} />
          </button>
        </div>
        <button
          onClick={() => setShowNew(true)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '9px 12px',
            background: C.accentBg,
            border: `1px solid ${C.accentBorder}`,
            borderRadius: 8,
            color: C.accentSoft,
            font: 'inherit',
            fontSize: 12.5,
            fontWeight: 500,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span style={{ display: 'flex', color: C.accent }}>
            <Icon name="plus" size={15} />
          </span>
          New session
          <span style={{ marginLeft: 'auto', fontSize: 11, color: C.dim, fontWeight: 400 }}>⌘N</span>
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 10px 16px' }}>
        {groups.length === 0 && (
          <div style={{ padding: '24px 8px', fontSize: 11.5, color: C.dim, textAlign: 'center', lineHeight: 1.7 }}>
            No sessions yet.
            <br />
            Create one to get started.
          </div>
        )}
        {groups.map((g) => (
          <Group key={g.name} group={g} slots={slots} altHeld={altHeld} />
        ))}
      </div>
    </div>
  )
}
