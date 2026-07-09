import { Fragment, useMemo, useState } from 'react'
import type { ProjectConfig, Session } from '../../shared/types'
import { C, STATUS_COLORS, STATUS_LABELS, dotStyle, sz } from '../theme'
import { Icon, type IconName } from '../icons'
import { LAYOUT_COUNT, type LayoutName, type ProjectGroup, buildGroups, useStore } from '../state/store'

const HEADER_BTN_HOVER = 'rgba(214,209,196,0.06)'

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

const LAYOUTS: { name: LayoutName; icon: IconName; label: string }[] = [
  { name: 'single', icon: 'single', label: 'Single pane' },
  { name: 'cols2', icon: 'columns', label: 'Two columns' },
  { name: 'grid4', icon: 'grid', label: 'Grid · 4 panes' },
]

/** Id of the session row currently being dragged (sidebar reorder). */
let draggedId: string | null = null

function activityColor(s: Session): string {
  if (s.status === 'waiting') return C.accentSoft
  if (s.status === 'error') return C.danger
  return C.muted
}

function Row({ session }: { session: Session }): React.JSX.Element {
  const shown = useStore((s) => s.panes.includes(session.id))
  const focusedId = useStore((s) => s.panes[s.focused])
  const openSession = useStore((s) => s.openSession)
  const setConfirm = useStore((s) => s.setConfirm)
  const reorderWithinGroup = useStore((s) => s.reorderWithinGroup)
  const [dragOver, setDragOver] = useState(false)
  const active = focusedId === session.id
  // The accent "selected" treatment is reserved for the single focused session.
  // A notified (needs-attention) session is signalled separately by the pulsing
  // dot below, so it never competes with selection when several are notified.

  // Drag-reorder: only allow a drop when the dragged session is in the same
  // project group (so groups stay contiguous).
  const sameGroupDrag = (): boolean => {
    if (!draggedId || draggedId === session.id) return false
    const dragged = useStore.getState().sessions[draggedId]
    return !!dragged && dragged.projectName === session.projectName
  }

  return (
    <div
      className="cc-row"
      draggable
      onClick={() => openSession(session.id)}
      onDragStart={(e) => {
        draggedId = session.id
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => {
        draggedId = null
        setDragOver(false)
      }}
      onDragOver={(e) => {
        if (!sameGroupDrag()) return
        e.preventDefault()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (draggedId) reorderWithinGroup(draggedId, session.id)
        draggedId = null
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 8px',
        borderRadius: 7,
        cursor: 'pointer',
        background: active
          ? 'rgba(217,119,87,0.1)'
          : shown
            ? 'rgba(214,209,196,0.04)'
            : 'transparent',
        border: `1px solid ${active ? 'rgba(217,119,87,0.22)' : 'transparent'}`,
        boxShadow: dragOver ? `inset 0 2px 0 ${C.accent}` : undefined,
      }}
    >
      <span style={dotStyle(session.status, 9)} />
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {session.kind === 'shell' && (
            <span style={{ display: 'flex', color: C.kindIcon, flex: 'none' }}>
              <Icon name="terminal" size={12} />
            </span>
          )}
          {session.kind === 'editor' && (
            <span style={{ display: 'flex', color: C.kindIcon, flex: 'none' }}>
              <Icon name="editor" size={12} />
            </span>
          )}
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
          {session.kind === 'claude' && session.mode === 'readonly' && (
            <span style={{ display: 'flex', color: C.muted, flex: 'none' }}>
              <Icon name="lock" size={11} />
            </span>
          )}
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
      <button
        className="cc-x"
        onClick={(e) => {
          e.stopPropagation()
          setConfirm({ kind: 'remove', id: session.id, name: session.name })
        }}
        title="Remove session"
        style={{
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
        }}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}

function LayoutMenu(): React.JSX.Element {
  const layout = useStore((s) => s.layout)
  const setLayout = useStore((s) => s.setLayout)
  const [open, setOpen] = useState(false)
  const current = LAYOUTS.find((l) => l.name === layout) ?? LAYOUTS[0]

  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Layout: ${current.label}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: sz(26),
          height: sz(26),
          borderRadius: 6,
          border: `1px solid ${C.border2}`,
          background: 'transparent',
          color: '#9a958a',
          cursor: 'pointer',
        }}
      >
        <Icon name={current.icon} size={15} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
          <div
            style={{
              position: 'absolute',
              top: 32,
              right: 0,
              zIndex: 31,
              width: 188,
              padding: 5,
              background: C.panel,
              border: `1px solid ${C.border3}`,
              borderRadius: 10,
              boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
              animation: 'cc-fade 0.12s ease',
            }}
          >
            {LAYOUTS.map((l) => (
              <div
                key={l.name}
                onClick={() => {
                  setLayout(l.name)
                  setOpen(false)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '7px 9px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: l.name === layout ? C.textHi : C.body,
                }}
              >
                <span style={{ display: 'flex', color: l.name === layout ? C.accent : C.muted, flex: 'none' }}>
                  <Icon name={l.icon} size={15} />
                </span>
                <span style={{ flex: 1, fontSize: 12.5 }}>{l.label}</span>
                {l.name === layout && (
                  <span style={{ display: 'flex', color: C.accent, flex: 'none' }}>
                    <Icon name="check" size={14} />
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * A session in the collapsed rail: a status-coloured dot (the "which session needs
 * me" signal). The accent "selected" ring is reserved for the single focused
 * session; a notified session is flagged by a distinct corner badge instead, so
 * several notified tabs never read as several selected ones.
 */
function RailTab({ session, index }: { session: Session; index: number }): React.JSX.Element {
  const focusedId = useStore((s) => s.panes[s.focused])
  const shown = useStore((s) => s.panes.includes(session.id))
  const openSession = useStore((s) => s.openSession)
  const active = focusedId === session.id
  const notified = session.notified && !active
  const hint = index < 9 ? `  (Alt+${index + 1})` : ''

  return (
    <button
      data-rail-session={session.id}
      onClick={() => openSession(session.id)}
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
        background: active
          ? 'rgba(217,119,87,0.1)'
          : shown
            ? 'rgba(214,209,196,0.04)'
            : 'transparent',
        border: `1px solid ${active ? 'rgba(217,119,87,0.22)' : 'transparent'}`,
      }}
    >
      <span style={dotStyle(session.status, 11)} />
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
 * Popover to set a project's Build/Run commands. Prefilled from the current config;
 * Save writes the whole `projects` array back through updateSettings (its `merge`
 * replaces `projects` wholesale). Anchored to the group header's button cluster.
 */
function ProjectCommandsMenu({
  projectName,
  projectPath,
  proj,
  onClose,
}: {
  projectName: string
  projectPath: string
  proj?: ProjectConfig
  onClose: () => void
}): React.JSX.Element {
  const setSettings = useStore((s) => s.setSettings)
  const [build, setBuild] = useState(proj?.buildCommand ?? '')
  const [run, setRun] = useState(proj?.runCommand ?? '')

  const save = async () => {
    const settings = useStore.getState().settings
    if (!settings) return
    const buildCommand = build.trim()
    const runCommand = run.trim()
    const exists = settings.projects.some((p) => p.path === projectPath)
    const projects = exists
      ? settings.projects.map((p) => (p.path === projectPath ? { ...p, buildCommand, runCommand } : p))
      : [...settings.projects, { name: projectName, path: projectPath, buildCommand, runCommand }]
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
          position: 'absolute',
          top: 26,
          right: 0,
          zIndex: 31,
          width: 236,
          padding: 12,
          background: C.panel,
          border: `1px solid ${C.border3}`,
          borderRadius: 10,
          boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
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
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button
            onClick={onClose}
            style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border3}`, borderRadius: 7, color: '#b4afa3', font: 'inherit', fontSize: 12, cursor: 'pointer' }}
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
 * One project group: a collapsible header (name + session count) carrying this
 * project's Build/Run buttons and a gear that opens the command editor, followed by
 * its session rows. Build/Run reuse one dedicated interactive terminal per project +
 * task, created inside this group; later clicks retype the command at its prompt.
 */
function Group({ group }: { group: ProjectGroup }): React.JSX.Element {
  const isCollapsed = useStore((s) => !!s.collapsed[group.name])
  const toggleGroup = useStore((s) => s.toggleGroup)
  const settings = useStore((s) => s.settings)
  const [menuOpen, setMenuOpen] = useState(false)

  const projectPath = group.sessions[0]?.projectPath ?? ''
  const proj = settings?.projects.find((p) => p.path === projectPath)
  const buildCmd = proj?.buildCommand?.trim()
  const runCmd = proj?.runCommand?.trim()

  const runTask = async (task: 'build' | 'run') => {
    const store = useStore.getState()
    let target = Object.values(store.sessions).find((x) => x.task === task && x.projectPath === projectPath)
    if (!target) {
      target = await window.terminator.createSession({
        kind: 'shell',
        mode: 'normal',
        task,
        name: task === 'build' ? 'Build' : 'Run',
        projectName: group.name,
        projectPath,
      })
      store.upsert(target)
    }
    store.openSession(target.id)
    await window.terminator.runTaskCommand(target.id, task)
  }

  const taskBtn = (task: 'build' | 'run', enabled: boolean): React.JSX.Element => (
    <button
      onClick={(e) => {
        e.stopPropagation()
        if (enabled) void runTask(task)
      }}
      title={enabled ? (task === 'build' ? 'Build' : 'Run') : `Set a ${task} command — click the gear`}
      style={{ ...headerBtnStyle, opacity: enabled ? 1 : 0.3, cursor: enabled ? 'pointer' : 'default' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = HEADER_BTN_HOVER)}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <Icon name={task === 'build' ? 'hammer' : 'play'} size={13} />
    </button>
  )

  return (
    <div>
      <div
        onClick={() => toggleGroup(group.name)}
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
        <span style={{ fontSize: 10, color: C.faint2 }}>{group.sessions.length}</span>
        <span style={{ flex: 1, height: 1, background: C.hair, minWidth: 8 }} />
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'flex', alignItems: 'center', gap: 1, position: 'relative', flex: 'none' }}
        >
          {taskBtn('build', !!buildCmd)}
          {taskBtn('run', !!runCmd)}
          <button
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            title="Set Build / Run commands for this project"
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
              proj={proj}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
      </div>
      {!isCollapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {group.sessions.map((s) => (
            <Row key={s.id} session={s} />
          ))}
        </div>
      )}
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const groups = useMemo(() => buildGroups(order, sessions), [order, sessions])
  const total = order.length
  const setShowNew = useStore((s) => s.setShowNew)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setShowNotes = useStore((s) => s.setShowNotes)
  const hidden = useStore((s) => s.sidebarHidden)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const sidebarSide = useStore((s) => s.settings?.sidebarSide ?? 'left')

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
    color: '#9a958a',
    cursor: 'pointer',
  }

  // Collapsed: a slim rail with expand + new-session and the session tabs as status
  // dots, so the "needs me" signal and session switching survive collapsing.
  if (hidden) {
    // Flatten to the same grouped order the expanded sidebar (and Alt+1..9) use,
    // tagging the first tab of each later group so we can draw a divider.
    const railItems = groups.flatMap((g, gi) =>
      g.sessions.map((s, si) => ({ session: s, groupStart: gi > 0 && si === 0 })),
    )
    const divider = <span style={{ width: 16, height: 1, background: C.hair, flex: 'none', margin: '1px 0' }} />
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
        <button onClick={toggleSidebar} title="Show sidebar (Ctrl/⌘B)" style={railBtn}>
          <Icon name="sidebar" size={16} />
        </button>
        <button
          onClick={() => setShowNew(true)}
          title="New session (⌘N)"
          style={{ ...railBtn, background: C.accentBg, border: `1px solid ${C.accentBorder}`, color: C.accent }}
        >
          <Icon name="plus" size={16} />
        </button>
        {railItems.length > 0 && divider}
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
          {railItems.map((it, i) => (
            <Fragment key={it.session.id}>
              {it.groupStart && divider}
              <RailTab session={it.session} index={i} />
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
              color: '#9a958a',
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
              color: '#9a958a',
              cursor: 'pointer',
              marginRight: 6,
            }}
          >
            <Icon name="settings" size={15} />
          </button>
          <LayoutMenu />
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
              color: '#9a958a',
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
          <Group key={g.name} group={g} />
        ))}
      </div>
    </div>
  )
}
