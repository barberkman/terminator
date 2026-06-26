import { useMemo, useState } from 'react'
import type { Session } from '../../shared/types'
import { C, STATUS_COLORS, dotStyle } from '../theme'
import { Icon, type IconName } from '../icons'
import { LAYOUT_COUNT, type LayoutName, buildGroups, useStore } from '../state/store'

const LAYOUTS: { name: LayoutName; icon: IconName; label: string }[] = [
  { name: 'single', icon: 'single', label: 'Single pane' },
  { name: 'cols2', icon: 'columns', label: 'Two columns' },
  { name: 'grid4', icon: 'grid', label: 'Grid · 4 panes' },
]

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
  const active = focusedId === session.id
  // A notified (needs-attention) session gets a clear highlight on its tab —
  // this is the primary in-app signal now that there's no popup toast.
  const notified = session.notified && !active

  return (
    <div
      className="cc-row"
      onClick={() => openSession(session.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 8px',
        borderRadius: 7,
        cursor: 'pointer',
        background: active
          ? 'rgba(217,119,87,0.1)'
          : notified
            ? 'rgba(217,119,87,0.14)'
            : shown
              ? 'rgba(214,209,196,0.04)'
              : 'transparent',
        border: `1px solid ${active ? 'rgba(217,119,87,0.22)' : notified ? 'rgba(217,119,87,0.4)' : 'transparent'}`,
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
          width: 18,
          height: 18,
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
          width: 26,
          height: 26,
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

export function Sidebar(): React.JSX.Element {
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const groups = useMemo(() => buildGroups(order, sessions), [order, sessions])
  const total = order.length
  const collapsed = useStore((s) => s.collapsed)
  const toggleGroup = useStore((s) => s.toggleGroup)
  const setShowNew = useStore((s) => s.setShowNew)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const hidden = useStore((s) => s.sidebarHidden)
  const toggleSidebar = useStore((s) => s.toggleSidebar)

  const railBtn: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: 7,
    border: `1px solid ${C.border2}`,
    background: 'transparent',
    color: '#9a958a',
    cursor: 'pointer',
  }

  // Collapsed: a slim rail with expand + new-session, so there's always a way back.
  if (hidden) {
    return (
      <div
        style={{
          width: 42,
          flex: 'none',
          background: C.sidebar,
          borderRight: `1px solid ${C.border}`,
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
      </div>
    )
  }

  return (
    <div
      style={{
        width: 262,
        flex: 'none',
        background: C.sidebar,
        borderRight: `1px solid ${C.border}`,
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
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
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
              width: 26,
              height: 26,
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
        {groups.map((g) => {
          const isCollapsed = collapsed[g.name]
          return (
            <div key={g.name}>
              <div
                onClick={() => toggleGroup(g.name)}
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
                <span style={{ fontSize: 10.5, letterSpacing: 0.6, color: C.dim, fontWeight: 600 }}>
                  {g.name}
                </span>
                <span style={{ fontSize: 10, color: C.faint2 }}>{g.sessions.length}</span>
                <span style={{ flex: 1, height: 1, background: C.hair }} />
              </div>
              {!isCollapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {g.sessions.map((s) => (
                    <Row key={s.id} session={s} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
