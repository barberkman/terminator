import { useEffect, useRef, useState } from 'react'
import type { Session } from '../../shared/types'
import { C, accentA, sz } from '../theme'
import { Icon, type IconName } from '../icons'
import { startFromSidebar } from '../menus'
import { isRestorable, useStore } from '../state/store'

/**
 * Gap between two launches. Confirming with a dozen Claude sessions ticked would
 * otherwise fork a dozen `claude` processes in the same tick — every one of them
 * reading its transcript and drawing its TUI at once, on a machine that has just
 * finished starting the app. Spaced out they come up one after another instead,
 * which costs a few seconds of wall clock and nothing else.
 */
const STAGGER_MS = 500

/**
 * Start each session in turn, off screen, the same way the sidebar's Start does —
 * terminal first, so no output is dropped (see `startFromSidebar`). Detached from
 * the component on purpose: the dialog closes on confirm and the rest of the
 * queue must not go with it.
 */
async function relaunchPaced(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, STAGGER_MS))
    // Re-checked each time round: the user is free to remove a session, or start
    // it by hand from the sidebar, while the queue is still working through.
    if (!isRestorable(useStore.getState().sessions[ids[i]])) continue
    startFromSidebar(ids[i])
  }
}

function kindIcon(s: Session): { name: IconName; color: string } {
  if (s.kind !== 'claude') return { name: 'terminal', color: C.kindIcon }
  if (s.mode === 'readonly') return { name: 'lock', color: C.muted }
  return { name: 'sparkle', color: C.accent }
}

function Checkbox({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: sz(17),
        height: sz(17),
        flex: 'none',
        borderRadius: 5,
        border: `1px solid ${on ? C.accentBorder : C.border3}`,
        background: on ? accentA(0.16) : 'transparent',
        color: on ? C.accent : 'transparent',
      }}
    >
      <Icon name="check" size={12} />
    </span>
  )
}

/**
 * The startup offer: everything left over from the previous run, every box
 * ticked, so bringing it all back is one click and leaving something out is one
 * more. Deliberately has no memory — last run's unticked boxes say nothing about
 * what you want back today.
 */
export function RelaunchPrompt(): React.JSX.Element | null {
  const offer = useStore((s) => s.relaunchOffer)
  const setOffer = useStore((s) => s.setRelaunchOffer)
  const sessions = useStore((s) => s.sessions)
  const panel = useRef<HTMLDivElement>(null)
  const [picked, setPicked] = useState<Record<string, boolean>>({})

  // Every box ticked, every time the prompt goes up — and the panel takes the
  // keyboard, the way the context menu does. Every other modal opens because you
  // clicked something, which moves focus off the terminal by itself; this one
  // opens on its own on top of a pane whose xterm has just grabbed the keyboard,
  // and xterm swallows Escape rather than letting it reach App's ladder. The pane
  // claims focus from a requestAnimationFrame (TerminalView) scheduled in the
  // same commit as this one, just ahead of it — so taking it back means going
  // last in that frame rather than acting now.
  useEffect(() => {
    if (!offer) return
    setPicked(Object.fromEntries(offer.map((id) => [id, true])))
    const raf = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(raf)
  }, [offer])

  if (!offer) return null

  const rows = offer.map((id) => sessions[id]).filter((s): s is Session => !!s)
  if (!rows.length) return null

  const chosen = rows.filter((s) => picked[s.id])
  const allOn = chosen.length === rows.length
  const close = () => setOffer(null)
  const confirm = () => {
    const ids = chosen.map((s) => s.id)
    close()
    void relaunchPaced(ids)
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
        ref={panel}
        tabIndex={-1}
        style={{
          outline: 'none',
          width: 460,
          maxWidth: '92vw',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          background: C.panel,
          border: `1px solid ${C.border3}`,
          borderRadius: 14,
          boxShadow: C.shadowModal,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '18px 20px 12px' }}>
          <span style={{ display: 'flex', color: C.accent }}>
            <Icon name="power" size={16} />
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.textMax }}>Relaunch sessions?</span>
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

        <div style={{ padding: '0 20px 12px', fontSize: 12, lineHeight: 1.6, color: C.body }}>
          {rows.length === 1
            ? 'One session from last time is not running. Relaunch it?'
            : `${rows.length} sessions from last time are not running. Untick any you'd rather leave alone.`}{' '}
          Claude sessions resume their conversation, and everything starts off screen — your
          panes stay as they are.
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 20px 8px' }}>
          <span style={{ fontSize: 10, letterSpacing: 0.4, color: C.dim, fontWeight: 600 }}>
            SESSIONS
          </span>
          <span style={{ flex: 1, height: 1, background: C.hair, minWidth: 8 }} />
          <button
            onClick={() =>
              setPicked(Object.fromEntries(rows.map((s) => [s.id, !allOn])))
            }
            style={{
              padding: '4px 9px',
              borderRadius: 6,
              border: `1px solid ${C.border2}`,
              background: 'transparent',
              color: C.muted,
              font: 'inherit',
              fontSize: 11,
              cursor: 'pointer',
              flex: 'none',
            }}
          >
            {allOn ? 'Untick all' : 'Tick all'}
          </button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '0 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
        >
          {rows.map((s) => {
            const on = !!picked[s.id]
            const icon = kindIcon(s)
            return (
              <div
                key={s.id}
                className="cc-row"
                onClick={() => setPicked((p) => ({ ...p, [s.id]: !p[s.id] }))}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: on ? accentA(0.07) : 'transparent',
                  border: `1px solid ${on ? C.accentBorder : C.border2}`,
                }}
              >
                <Checkbox on={on} />
                <span style={{ display: 'flex', flex: 'none', color: icon.color }}>
                  <Icon name={icon.name} size={14} />
                </span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span
                    style={{
                      fontSize: 12.5,
                      color: C.textHi,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {s.name}
                  </span>
                  {/* Two sessions called "api" in two projects are the normal case,
                      so the project (and the branch, when it's a worktree) is part
                      of the row rather than a tooltip. */}
                  <span
                    style={{
                      fontSize: 10.5,
                      color: C.dim,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {s.projectName}
                    {s.worktreePath ? ` · worktree ⑂ ${s.branch}` : ''}
                  </span>
                </div>
              </div>
            )
          })}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '16px 20px 20px',
          }}
        >
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
            Not now
          </button>
          <button
            onClick={confirm}
            disabled={!chosen.length}
            style={{
              padding: '10px 20px',
              background: chosen.length ? C.accent : accentA(0.4),
              border: 'none',
              borderRadius: 9,
              color: C.accentText,
              font: 'inherit',
              fontSize: 12.5,
              fontWeight: 700,
              cursor: chosen.length ? 'pointer' : 'default',
            }}
          >
            {chosen.length === rows.length && rows.length > 1
              ? `Relaunch all ${rows.length}`
              : `Relaunch ${chosen.length}`}
          </button>
        </div>
      </div>
    </div>
  )
}
