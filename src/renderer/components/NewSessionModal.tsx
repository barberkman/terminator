import { useEffect, useMemo, useState } from 'react'
import type { SessionRuntime, WslProbe } from '../../shared/types'
import { linuxToHost, parseWslUnc, runtimeKey, sameRuntime } from '../../shared/wsl-path'
import { C, accentA, ink, sz } from '../theme'
import { Icon } from '../icons'
import { errorText } from '../menus'
import { TYPES, TYPE_MAP, type TypeKey } from '../sessionTypes'
import { useStore } from '../state/store'
import { RuntimeChip } from './RuntimeChip'

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
  const prefill = useStore((s) => s.newPrefill)
  const setShowNew = useStore((s) => s.setShowNew)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const sessions = useStore((s) => s.sessions)
  const order = useStore((s) => s.order)
  const distros = useStore((s) => s.wslDistros) ?? []

  const [folder, setFolder] = useState('')
  /** Where the session runs. Undefined = Windows. */
  const [runtime, setRuntime] = useState<SessionRuntime | undefined>(undefined)
  /** What the chosen distro said about itself — its home for Browse, and anything missing. */
  const [probe, setProbe] = useState<WslProbe | null>(null)
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
    // Keyed by runtime and path together: the same Linux path in two distros, or a
    // WSL and a Windows project that happen to match, are different projects.
    const list: { name: string; path: string; runtime?: SessionRuntime; removable: boolean }[] = []
    for (const id of order) {
      const s = sessions[id]
      const key = s ? `${runtimeKey(s.runtime)}|${s.projectPath}` : ''
      if (s && !seen.has(key)) {
        seen.add(key)
        list.push({ name: s.projectName, path: s.projectPath, runtime: s.runtime, removable: false })
      }
    }
    for (const p of settings?.projects ?? []) {
      const key = `${runtimeKey(p.runtime)}|${p.path}`
      if (!seen.has(key)) {
        seen.add(key)
        list.push({ ...p, removable: true })
      }
    }
    return list
  }, [order, sessions, settings])

  const namePlaceholder = useMemo(() => {
    if (kind === 'shell') return 'shell'
    // Same name a link-opened one gets; main numbers it if the project has one already.
    if (kind === 'browser') return 'Web'
    return basename(folder) || 'session'
  }, [kind, folder])

  // Opened from a sidebar menu's "More options…": start on that project, with
  // name / type / worktree / branch still to choose. Seeding on open (rather than
  // trusting the previous close to have reset) makes the open authoritative.
  // Above the early return below — a hook must not sit under one.
  useEffect(() => {
    if (!show) return
    setFolder(prefill?.projectPath ?? '')
    setRuntime(prefill?.runtime)
    setName('')
    setKind('claude')
    setWorktree(false)
    setBranch('')
    // Distros come and go (an install, an unregister); listing never boots one.
    void useStore.getState().loadWslDistros(true)
  }, [show, prefill])

  // Ask the chosen distro about itself: its home is where Browse opens, and a
  // missing `claude` or a closed way back is better said here than found later.
  const distro = runtime?.kind === 'wsl' ? runtime.distro : ''
  useEffect(() => {
    setProbe(null)
    if (!show || !distro) return
    let live = true
    window.terminator
      .wslProbe(distro)
      .then((p) => live && setProbe(p))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [show, distro])

  if (!show) return null

  const reset = () => {
    setFolder('')
    setRuntime(undefined)
    setName('')
    setKind('claude')
    setWorktree(false)
    setBranch('')
  }

  /** The registered spelling of a distro named in a path, which may be any case. */
  const distroNamed = (n: string): string =>
    distros.find((d) => d.name.toLowerCase() === n.toLowerCase())?.name ?? n
  const defaultDistro = (): string => distros.find((d) => d.isDefault)?.name ?? distros[0]?.name ?? ''

  /**
   * A folder as the user gave it, settled into what will be sent: a \\wsl.localhost
   * path picks its distro and becomes the Linux path it stands for, and a bare
   * `/…` path — which means nothing on Windows — goes to the default distro. Anything
   * else keeps the runtime already chosen.
   */
  const settleFolder = (raw: string): void => {
    const unc = parseWslUnc(raw)
    if (unc) {
      setRuntime({ kind: 'wsl', distro: distroNamed(unc.distro) })
      setFolder(unc.linux)
      return
    }
    setFolder(raw)
    if (!runtime && distros.length && raw.startsWith('/') && !raw.startsWith('//')) {
      setRuntime({ kind: 'wsl', distro: defaultDistro() })
    }
  }
  const close = () => {
    setShowNew(false)
    reset()
  }

  const browse = async () => {
    // A WSL session browses its distro: from the folder typed so far, else its home.
    let start: string | undefined
    if (distro) {
      const linux = folder.trim().startsWith('/') ? folder.trim() : probe?.home
      if (linux) start = linuxToHost(distro, linux)
    }
    const picked = await window.terminator.pickFolder(start)
    if (picked) {
      settleFolder(picked)
      // Not for a browser session: the folder only decides which group it lands
      // in, and naming it after one would take it out of the Web / Web 2 run.
      if (!name && kind !== 'browser') setName(basename(picked))
    }
  }

  const removeRecent = async (path: string, rt?: SessionRuntime) => {
    if (!settings) return
    const projects = settings.projects.filter((p) => !(p.path === path && sameRuntime(p.runtime, rt)))
    const result = await window.terminator.updateSettings({ projects })
    setSettings(result)
    if (folder === path && sameRuntime(runtime, rt)) setFolder('')
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
        ...(runtime ? { runtime } : {}),
      })
      useStore.getState().upsert(session)
      useStore.getState().openSession(session.id)
      close()
    } catch (e) {
      // Stays open, so the folder can be fixed rather than retyped. A WSL folder is
      // checked inside its distro, which is where most of these come from.
      useStore.getState().pushToast({ tone: 'error', text: "Couldn't create the session", sub: errorText(e) })
    } finally {
      setBusy(false)
    }
  }

  /** One thing worth knowing about the chosen distro before starting there, or ''. */
  const probeHint = ((): string => {
    if (!distro || !probe) return ''
    if (!probe.ok) return probe.reason || `${distro} isn't answering`
    if (!probe.interop || !probe.exeReachable) {
      return "WSL interop is off in this distro, so sessions here can't report their status."
    }
    if (kind === 'claude' || kind === 'claude-ro') {
      if (!probe.claudePath) return `claude isn't on the PATH in ${distro} — install it there first.`
    }
    return ''
  })()

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: C.scrim,
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
          boxShadow: C.shadowModal,
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
              width: sz(26),
              height: sz(26),
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
          {/* Only where there is a choice: no WSL, no row. */}
          {distros.length > 0 && (
            <div>
              <Label>RUN IN</Label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[undefined, ...distros.map((d): SessionRuntime => ({ kind: 'wsl', distro: d.name }))].map(
                  (rt) => {
                    const selected = sameRuntime(rt, runtime)
                    return (
                      <button
                        key={runtimeKey(rt)}
                        onClick={() => {
                          if (selected) return
                          setRuntime(rt)
                          // A folder only means something in the runtime it was picked
                          // in, so switching starts the folder over.
                          setFolder('')
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                          padding: '7px 12px',
                          borderRadius: 999,
                          cursor: 'pointer',
                          font: 'inherit',
                          fontSize: 12,
                          color: selected ? C.textHi : C.text,
                          background: selected ? accentA(0.08) : C.input,
                          border: `1px solid ${selected ? C.accentBorder : C.border2}`,
                        }}
                      >
                        {rt ? `WSL · ${rt.distro}` : 'Windows'}
                      </button>
                    )
                  },
                )}
              </div>
              {probeHint && (
                <div style={{ fontSize: 11, color: C.dim, marginTop: 7 }}>{probeHint}</div>
              )}
            </div>
          )}

          <div>
            <Label>PROJECT FOLDER</Label>
            <div style={{ display: 'flex', gap: 8, marginBottom: recents.length ? 9 : 0 }}>
              <input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                // Settled when you leave the box rather than on every keystroke, so a
                // half-typed \\wsl.localhost path isn't rewritten out from under you.
                onBlur={(e) => settleFolder(e.target.value.trim())}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text').trim()
                  if (!parseWslUnc(text)) return
                  e.preventDefault()
                  settleFolder(text)
                }}
                placeholder={distro ? `${probe?.home || '~'}/code/my-project` : '~/code/my-project'}
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
                  const selected = folder === rf.path && sameRuntime(runtime, rf.runtime)
                  return (
                    <div
                      key={`${runtimeKey(rf.runtime)}|${rf.path}`}
                      className="cc-row"
                      onClick={() => {
                        setFolder(rf.path)
                        setRuntime(rf.runtime)
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '7px 9px',
                        borderRadius: 7,
                        cursor: 'pointer',
                        background: selected ? accentA(0.08) : 'transparent',
                      }}
                    >
                      <span style={{ display: 'flex', color: C.muted, flex: 'none' }}>
                        <Icon name="folder" size={14} />
                      </span>
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span style={{ fontSize: 12, color: C.textHi, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {rf.name}
                          </span>
                          <RuntimeChip runtime={rf.runtime} />
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
                            void removeRecent(rf.path, rf.runtime)
                          }}
                          title="Remove from recent projects"
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
                    onClick={() => {
                      setKind(t.key)
                      // The toggle below is hidden for a browser session, so a tick
                      // left over from another kind would be submitted unseen.
                      if (t.key === 'browser') setWorktree(false)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 11,
                      padding: '10px 12px',
                      borderRadius: 9,
                      cursor: 'pointer',
                      background: selected ? accentA(0.08) : C.input,
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

          {/* A browser session never touches the filesystem, so a worktree for
              one would be a branch nothing could ever be committed on. The other
              kinds all have a use for it, including the editor. */}
          {kind !== 'browser' && (
            <div>
              <div onClick={() => setWorktree((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer' }}>
                <span
                  style={{
                    width: 36,
                    height: 20,
                    borderRadius: 12,
                    flex: 'none',
                    background: worktree ? C.accent : ink(0.14),
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
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '18px 20px 20px', marginTop: 6 }}>
          <button
            onClick={close}
            style={{
              padding: '10px 18px',
              background: 'transparent',
              border: `1px solid ${C.border3}`,
              borderRadius: 9,
              color: C.textBtn,
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
              background: !folder.trim() || busy ? accentA(0.4) : C.accent,
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
