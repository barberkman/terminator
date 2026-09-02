import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptPrompt } from '../../shared/types'
import { C, accentA, ink, sz } from '../theme'
import { Icon } from '../icons'
import { useStore } from '../state/store'

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
  boxSizing: 'border-box',
}

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ fontSize: 11, letterSpacing: 0.6, color: C.muted, fontWeight: 600, marginBottom: 8 }}>
      {children}
    </div>
  )
}

/** A prompt on one line — newlines and runs of spaces collapsed. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clock(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'
}

/**
 * The cut, which sits in the *gap* between two prompts rather than on a prompt:
 * everything above it comes along, everything below is left behind. Quiet until
 * hovered or chosen, so the list still reads as a list of prompts.
 */
function Gap({ active, onPick }: { active: boolean; onPick: () => void }): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const line = active ? C.accent : hover ? C.border3 : 'transparent'
  return (
    <div
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, height: 18, cursor: 'pointer', padding: '0 4px' }}
    >
      <span style={{ flex: 1, height: 1, background: line }} />
      <span
        style={{
          fontSize: 9,
          letterSpacing: 0.6,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          color: active ? C.accent : C.faint2,
        }}
      >
        {active ? 'BRANCH FROM HERE' : hover ? 'branch here' : ''}
      </span>
      <span style={{ flex: 1, height: 1, background: line }} />
    </div>
  )
}

/**
 * Branch a Claude conversation: pick the point to cut it at, and get a sibling
 * session that carries the history above that point. The parent is only read —
 * it keeps running, so both roads stay open side by side.
 */
export function BranchModal(): React.JSX.Element | null {
  const parentId = useStore((s) => s.branchFor)
  const setBranchFor = useStore((s) => s.setBranchFor)
  const parent = useStore((s) => (s.branchFor ? s.sessions[s.branchFor] : undefined))
  const existingBranches = useStore(
    (s) => Object.values(s.sessions).filter((x) => x.parentId === s.branchFor).length,
  )

  const [prompts, setPrompts] = useState<TranscriptPrompt[] | null>(null)
  // How many of the parent's prompts the branch carries — i.e. the gap the cut
  // sits in. `prompts.length` is the tip (carry the whole conversation).
  const [kept, setKept] = useState(0)
  const [name, setName] = useState('')
  const [carry, setCarry] = useState(true)
  const [worktree, setWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const defaultName = useMemo(
    () => (parent ? `${parent.name} ⑂${existingBranches + 1}` : ''),
    [parent, existingBranches],
  )

  useEffect(() => {
    if (!parentId) return
    let live = true
    setPrompts(null)
    setError('')
    setBusy(false)
    setCarry(true)
    setWorktree(false)
    setBranch('')
    setName('')
    void window.terminator.listPrompts(parentId).then((list) => {
      if (!live) return
      setPrompts(list)
      // Default to the last gap: branch and re-ask the most recent prompt.
      setKept(Math.max(0, list.length - 1))
    })
    return () => {
      live = false
    }
  }, [parentId])

  // Keep the cut in view when the list first lands (it defaults near the bottom).
  useEffect(() => {
    if (prompts?.length) listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [prompts])

  if (!parentId || !parent) return null

  const close = () => setBranchFor(null)
  const reAsking = prompts && kept < prompts.length ? prompts[kept] : undefined
  const canBranch = !!prompts && prompts.length > 0 && !busy

  const submit = async () => {
    if (!prompts || !canBranch) return
    setBusy(true)
    setError('')
    const result = await window.terminator.branchSession({
      parentId,
      cutBeforeUuid: kept < prompts.length ? prompts[kept].uuid : null,
      keptPrompts: kept,
      name: name.trim() || defaultName,
      worktree,
      branch: worktree ? branch.trim() || slug(name.trim() || defaultName) : undefined,
      prefill: carry && reAsking ? reAsking.text : undefined,
    })
    if (!result.ok) {
      setError(result.reason)
      setBusy(false)
      return
    }
    const store = useStore.getState()
    store.upsert(result.session)
    store.openSession(result.session.id)
    close()
  }

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
          width: 520,
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
            <Icon name="branch" size={16} />
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.textMax }}>Branch conversation</span>
          <span
            style={{
              fontSize: 11.5,
              color: C.dim,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            from {parent.name}
          </span>
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
              flex: 'none',
            }}
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <Label>BRANCH POINT</Label>
            {prompts === null && (
              <div style={{ fontSize: 12, color: C.dim, padding: '14px 4px' }}>Reading the conversation…</div>
            )}
            {prompts?.length === 0 && (
              <div style={{ fontSize: 12, color: C.dim, padding: '14px 4px', lineHeight: 1.6 }}>
                This session has no saved prompts yet — send it something first, then branch.
              </div>
            )}
            {!!prompts?.length && (
              <div
                ref={listRef}
                style={{
                  maxHeight: 250,
                  overflowY: 'auto',
                  background: C.input,
                  border: `1px solid ${C.border2}`,
                  borderRadius: 9,
                  padding: '6px 6px 8px',
                }}
              >
                {prompts.map((p, i) => {
                  const included = i < kept
                  return (
                    <div key={p.uuid}>
                      <Gap active={kept === i} onPick={() => setKept(i)} />
                      <div
                        onClick={() => setKept(i)}
                        title={p.text}
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: 9,
                          padding: '5px 6px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          opacity: included ? 1 : 0.42,
                        }}
                      >
                        <span style={{ fontSize: 10, color: C.faint, width: 14, flex: 'none' }}>{p.index}</span>
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 11.5,
                            color: included ? C.text : C.muted,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            textDecoration: included ? 'none' : 'line-through',
                          }}
                        >
                          {oneLine(p.text)}
                        </span>
                        <span style={{ fontSize: 10, color: C.faint2, flex: 'none' }}>{clock(p.timestamp)}</span>
                      </div>
                    </div>
                  )
                })}
                <Gap active={kept === prompts.length} onPick={() => setKept(prompts.length)} />
              </div>
            )}
            {!!prompts?.length && (
              <div style={{ fontSize: 11, color: C.dim, marginTop: 8, lineHeight: 1.6 }}>
                {kept === 0
                  ? 'The branch starts from an empty conversation.'
                  : `The branch carries ${kept} prompt${kept > 1 ? 's' : ''} and everything Claude replied to ${kept > 1 ? 'them' : 'it'}.`}
                {reAsking ? ` Prompt ${reAsking.index} onward is left with ${parent.name}.` : ''}
              </div>
            )}
          </div>

          {!!reAsking && (
            <div
              onClick={() => setCarry((v) => !v)}
              style={{ display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer' }}
            >
              <span
                style={{
                  width: 36,
                  height: 20,
                  borderRadius: 12,
                  flex: 'none',
                  background: carry ? C.accent : ink(0.14),
                  position: 'relative',
                  transition: 'background 0.15s ease',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: carry ? 18 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 0.15s ease',
                  }}
                />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: C.textHi }}>Start with prompt {reAsking.index} in the input box</div>
                <div
                  style={{
                    fontSize: 11,
                    color: C.dim,
                    marginTop: 1,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  Waiting there unsent, so you can ask it differently
                </div>
              </div>
            </div>
          )}

          <div>
            <Label>NAME</Label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              style={{ ...inputStyle, fontSize: 13 }}
            />
          </div>

          <div>
            <div
              onClick={() => setWorktree((v) => !v)}
              style={{ display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer' }}
            >
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
                <div style={{ fontSize: 11, color: C.dim, marginTop: 1 }}>
                  {parent.alive && parent.mode === 'normal'
                    ? `${parent.name} is live and can edit files in ${parent.branch} — a worktree keeps them apart`
                    : `Otherwise the branch runs in the same folder as ${parent.name}`}
                </div>
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
                  placeholder={slug(name.trim() || defaultName)}
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: C.accentSoft,
                    font: 'inherit',
                    fontSize: 12.5,
                  }}
                />
              </div>
            )}
          </div>

          {!!error && (
            <div style={{ fontSize: 11.5, color: C.danger, lineHeight: 1.5 }}>Couldn't branch: {error}</div>
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
            onClick={() => void submit()}
            disabled={!canBranch}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              background: canBranch ? C.accent : accentA(0.4),
              border: 'none',
              borderRadius: 9,
              color: C.accentText,
              font: 'inherit',
              fontSize: 12.5,
              fontWeight: 700,
              cursor: canBranch ? 'pointer' : 'default',
            }}
          >
            {busy ? 'Branching…' : 'Branch'}
          </button>
        </div>
      </div>
    </div>
  )
}
