import { useMemo, useState } from 'react'
import type { CreateSessionInput } from '../../shared/types'
import { C } from '../theme'
import { Icon, type IconName } from '../icons'
import { useStore } from '../state/store'

type TypeKey = 'claude' | 'claude-ro' | 'shell' | 'editor'

const TYPES: { key: TypeKey; icon: IconName; color: string; label: string; desc: string }[] = [
  { key: 'claude', icon: 'sparkle', color: C.accent, label: 'Claude', desc: 'Normal Claude Code session' },
  { key: 'claude-ro', icon: 'lock', color: C.muted, label: 'Claude · read-only', desc: 'Runs the read-only command' },
  { key: 'shell', icon: 'terminal', color: C.kindIcon, label: 'Terminal', desc: 'Plain shell — no Claude features' },
  { key: 'editor', icon: 'editor', color: C.kindIcon, label: 'Editor', desc: 'Browse and edit files — no Claude, no shell' },
]

const TYPE_MAP: Record<TypeKey, Pick<CreateSessionInput, 'kind' | 'mode'>> = {
  claude: { kind: 'claude', mode: 'normal' },
  'claude-ro': { kind: 'claude', mode: 'readonly' },
  shell: { kind: 'shell', mode: 'normal' },
  editor: { kind: 'editor', mode: 'normal' },
}

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? ''
}

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ fontSize: 11, letterSpacing: 0.6, color: C.muted, fontWeight: 600, marginBottom: 8 }}>
      {children}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: C.input,
  border: `1px solid ${C.border2}`,
  borderRadius: 9,
  color: C.textHi,
  font: 'inherit',
  fontSize: 12.5,
  outline: 'none',
}

export function NewSessionModal(): React.JSX.Element | null {
  const show = useStore((s) => s.showNew)
  const setShowNew = useStore((s) => s.setShowNew)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const sessions = useStore((s) => s.sessions)
  const order = useStore((s) => s.order)

  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TypeKey>('claude')
  const [worktree, setWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)

  // Folders from existing session groups (current projects) first, then any
  // other remembered projects — so you can add a session to an existing group.
  const recents = useMemo(() => {
    const seen = new Set<string>()
    // `removable` is true only for remembered projects with no live session — a
    // session-backed project can't be deleted from the list while its session exists.
    const list: { name: string; path: string; removable: boolean }[] = []
    for (const id of order) {
      const s = sessions[id]
      if (s && !seen.has(s.projectPath)) {
        seen.add(s.projectPath)
        list.push({ name: s.projectName, path: s.projectPath, removable: false })
      }
    }
    for (const p of settings?.projects ?? []) {
      if (!seen.has(p.path)) {
        seen.add(p.path)
        list.push({ ...p, removable: true })
      }
    }
    return list
  }, [order, sessions, settings])

  const namePlaceholder = useMemo(() => {
    if (kind === 'shell') return 'shell'
    return basename(folder) || 'session'
  }, [kind, folder])

  if (!show) return null

  const reset = () => {
    setFolder('')
    setName('')
    setKind('claude')
    setWorktree(false)
    setBranch('')
  }
  const close = () => {
    setShowNew(false)
    reset()
  }

  const browse = async () => {
    const picked = await window.terminator.pickFolder()
    if (picked) {
      setFolder(picked)
      if (!name) setName(basename(picked))
    }
  }

  const removeRecent = async (path: string) => {
    if (!settings) return
    const projects = settings.projects.filter((p) => p.path !== path)
    const result = await window.terminator.updateSettings({ projects })
    setSettings(result)
    if (folder === path) setFolder('')
  }

  const create = async () => {
    if (!folder.trim() || busy) return
    setBusy(true)
    try {
      const session = await window.terminator.createSession({
        ...TYPE_MAP[kind],
        name: name.trim() || undefined,
        projectPath: folder.trim(),
        worktree,
        branch: worktree ? branch.trim() || undefined : undefined,
      })
      useStore.getState().upsert(session)
      useStore.getState().openSession(session.id)
      close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(10,9,8,0.66)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'cc-fade 0.18s ease',
      }}
    >
      <div
        style={{
          width: 480,
          maxWidth: '92vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: C.panel,
          border: `1px solid ${C.border3}`,
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '18px 20px 14px' }}>
          <span style={{ display: 'flex', color: C.accent }}>
            <Icon name="plus" size={16} />
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.textMax }}>New session</span>
          <button
            onClick={close}
            style={{
              marginLeft: 'auto',
              display: 'flex',
              width: 26,
              height: 26,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: C.muted,
              cursor: 'pointer',
            }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>

        <div style={{ padding: '0 20px 4px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <Label>PROJECT FOLDER</Label>
            <div style={{ display: 'flex', gap: 8, marginBottom: recents.length ? 9 : 0 }}>
              <input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="~/code/my-project"
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              />
              <button
                onClick={browse}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '0 14px',
                  background: C.input,
                  border: `1px solid ${C.border3}`,
                  borderRadius: 9,
                  color: C.text,
                  font: 'inherit',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  flex: 'none',
                }}
              >
                <span style={{ display: 'flex', color: C.muted }}>
                  <Icon name="folder" size={14} />
                </span>
                Browse…
              </button>
            </div>
            {recents.length > 0 && (
              <>
                <div style={{ fontSize: 10, letterSpacing: 0.4, color: C.dim, fontWeight: 600, margin: '2px 0 6px' }}>
                  PROJECTS
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 140, overflowY: 'auto' }}>
                  {recents.map((rf) => {
                  const selected = folder === rf.path
                  return (
                    <div
                      key={rf.path}
                      className="cc-row"
                      onClick={() => setFolder(rf.path)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '7px 9px',
                        borderRadius: 7,
                        cursor: 'pointer',
                        background: selected ? 'rgba(217,119,87,0.08)' : 'transparent',
                      }}
                    >
                      <span style={{ display: 'flex', color: C.muted, flex: 'none' }}>
                        <Icon name="folder" size={14} />
                      </span>
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <span style={{ fontSize: 12, color: C.textHi, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {rf.name}
                        </span>
                        <span style={{ fontSize: 10.5, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {rf.path}
                        </span>
                      </div>
                      {selected && (
                        <span style={{ display: 'flex', color: C.accent, flex: 'none' }}>
                          <Icon name="check" size={14} />
                        </span>
                      )}
                      {rf.removable && (
                        <button
                          className="cc-x"
                          onClick={(e) => {
                            e.stopPropagation()
                            void removeRecent(rf.path)
                          }}
                          title="Remove from recent projects"
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
                      )}
                    </div>
                  )
                  })}
                </div>
              </>
            )}
          </div>

          <div>
            <Label>SESSION NAME</Label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={namePlaceholder}
              style={{ ...inputStyle, fontSize: 13 }}
            />
          </div>

          <div>
            <Label>SESSION TYPE</Label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {TYPES.map((t) => {
                const selected = kind === t.key
                return (
                  <div
                    key={t.key}
                    onClick={() => setKind(t.key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 11,
                      padding: '10px 12px',
                      borderRadius: 9,
                      cursor: 'pointer',
                      background: selected ? 'rgba(217,119,87,0.08)' : C.input,
                      border: `1px solid ${selected ? C.accentBorder : C.border2}`,
                    }}
                  >
                    <span style={{ display: 'flex', flex: 'none', color: t.color }}>
                      <Icon name={t.icon} size={16} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: C.textHi }}>{t.label}</div>
                      <div style={{ fontSize: 11, color: C.dim, marginTop: 1 }}>{t.desc}</div>
                    </div>
                    {selected && (
                      <span style={{ display: 'flex', flex: 'none', color: C.accent }}>
                        <Icon name="check" size={16} />
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div>
            <div onClick={() => setWorktree((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer' }}>
              <span
                style={{
                  width: 36,
                  height: 20,
                  borderRadius: 12,
                  flex: 'none',
                  background: worktree ? C.accent : 'rgba(214,209,196,0.14)',
                  position: 'relative',
                  transition: 'background 0.15s ease',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: worktree ? 18 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 0.15s ease',
                  }}
                />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, color: C.textHi }}>Create git worktree</div>
                <div style={{ fontSize: 11, color: C.dim, marginTop: 1 }}>Isolate this session on its own branch</div>
              </div>
            </div>
            {worktree && (
              <div
                style={{
                  marginTop: 11,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '9px 12px',
                  background: C.input,
                  border: `1px solid ${C.border2}`,
                  borderRadius: 9,
                }}
              >
                <span style={{ fontSize: 12.5, color: C.muted }}>branch</span>
                <input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="feature/my-work"
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: C.accentSoft, font: 'inherit', fontSize: 12.5 }}
                />
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '18px 20px 20px', marginTop: 6 }}>
          <button
            onClick={close}
            style={{
              padding: '10px 18px',
              background: 'transparent',
              border: `1px solid ${C.border3}`,
              borderRadius: 9,
              color: '#b4afa3',
              font: 'inherit',
              fontSize: 12.5,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!folder.trim() || busy}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              background: !folder.trim() || busy ? 'rgba(217,119,87,0.4)' : C.accent,
              border: 'none',
              borderRadius: 9,
              color: C.accentText,
              font: 'inherit',
              fontSize: 12.5,
              fontWeight: 700,
              cursor: !folder.trim() || busy ? 'default' : 'pointer',
            }}
          >
            Create session
          </button>
        </div>
      </div>
    </div>
  )
}
