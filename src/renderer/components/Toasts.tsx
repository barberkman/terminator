import { useEffect, useMemo, useRef, useState } from 'react'
import { openAttachment, revealAttachment } from '../attach'
import { fileManagerVerb, openLabel, toastMenu } from '../menus'
import { type ToastItem, useStore } from '../state/store'
import { C, accentA, dangerA } from '../theme'
import { Icon, type IconName } from '../icons'
import { MenuPanel } from './ContextMenu'

// The app's only transient message surface. Attachments need one in both
// directions: a terminal can't show you the screenshot you just pasted, and a
// drop that couldn't be attached has nowhere else to say why. Copying a code
// block out of a conversation is the same shape of thing: it happened somewhere
// the result isn't visible.
//
// A toast that names one file on disk is also the only place that file is ever
// mentioned, so it carries the ways back to it: the body opens it, the folder
// button shows it where it landed, right-click has both plus Copy path. Anything
// that isn't one file — a failure, a multi-item drop, the copy-path toast the
// session menus raise — carries no `action` and stays inert rather than greyed
// out, for the reason ContextMenu.tsx gives for having no disabled rows at all.
// The card reads `action`, never `tone`, so nothing here is keyed off being an
// error; a toast simply has something to open or it doesn't.

const TTL = { ok: 5000, error: 11000 }

/**
 * The longest a card can live regardless of holds. Pausing has to be generous —
 * reading a path and aiming at a small button both take longer than five seconds
 * — but a pointer parked in the corner of the window must not be able to turn a
 * transient message into furniture.
 */
const MAX_LIFETIME = 30000

/** The two right-edge controls: one box, one tint, differing only in the glyph. */
function CardButton({
  icon,
  title,
  bad,
  onClick,
}: {
  icon: IconName
  title: string
  bad: boolean
  onClick: () => void
}): React.JSX.Element {
  // The resting tint depends on the tone, so the hover tint has to as well —
  // which one static rule in the stylesheet can't express. State, then, and the
  // stylesheet keeps only the focus ring.
  const [hot, setHot] = useState(false)
  return (
    <button
      type="button"
      className="cc-toast-btn"
      title={title}
      aria-label={title}
      onClick={onClick}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{
        flex: 'none',
        display: 'flex',
        padding: 4,
        borderRadius: 6,
        border: 'none',
        background: bad ? dangerA(hot ? 0.22 : 0.12) : accentA(hot ? 0.2 : 0.1),
        color: hot ? C.textHi : C.muted,
        cursor: 'pointer',
        transition: 'background 0.12s ease, color 0.12s ease',
      }}
    >
      <Icon name={icon} size={11} />
    </button>
  )
}

function Toast({
  toast,
  held,
  onMenu,
}: {
  toast: ToastItem
  /** True while the stack is being read — see the note on hover in `Toasts`. */
  held: boolean
  onMenu: (x: number, y: number) => void
}): React.JSX.Element {
  const dismiss = useStore((s) => s.dismissToast)
  const bad = toast.tone === 'error'
  const act = toast.action
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const cap = setTimeout(() => dismiss(toast.id), MAX_LIFETIME)
    return () => clearTimeout(cap)
  }, [toast.id, dismiss])

  // The countdown is a budget that gets spent, not a timer that restarts: while
  // held nothing is scheduled, and the cleanup on the way into a hold banks
  // however much already elapsed. Three pauses still buy one lifetime, and a card
  // released with 200ms left leaves 200ms later.
  const remaining = useRef(TTL[toast.tone])
  useEffect(() => {
    if (held) return
    const from = Date.now()
    const t = setTimeout(() => dismiss(toast.id), remaining.current)
    return () => {
      clearTimeout(t)
      remaining.current = Math.max(0, remaining.current - (Date.now() - from))
    }
  }, [held, toast.id, dismiss])

  // A click can land in the gap between dismissing and React taking the node
  // away, and a held Enter repeats. One shot per card, whichever surface fires it.
  const spent = useRef(false)
  const fire = (run: (path: string) => void) => (): void => {
    if (!act || spent.current) return
    spent.current = true
    run(act.path)
    // Whatever opens is the confirmation — there is nothing left for the card to say.
    dismiss(toast.id)
  }
  const open = fire((p) => void openAttachment(p))
  const reveal = fire((p) => void revealAttachment(p))

  // The negative margin is matched to the padding: it gives the hover wash real
  // area to fill without moving any of the card's own metrics.
  const bodyStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    margin: '-6px -8px',
    padding: '6px 8px',
    borderRadius: 8,
    textAlign: 'left',
  }

  const inner = (
    <>
      {toast.thumb ? (
        <img
          src={toast.thumb}
          alt=""
          style={{
            width: 34,
            height: 34,
            flex: 'none',
            objectFit: 'cover',
            borderRadius: 5,
            border: `1px solid ${C.border2}`,
            background: C.input,
          }}
        />
      ) : (
        <span style={{ display: 'flex', flex: 'none', color: bad ? C.danger : C.accent }}>
          <Icon name={bad ? 'close' : (toast.icon ?? 'paperclip')} size={15} />
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: C.textMax, fontWeight: 500, wordBreak: 'break-word' }}>
          {toast.text}
        </div>
        {toast.sub && (
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2, wordBreak: 'break-word' }}>
            {toast.sub}
          </div>
        )}
      </div>
    </>
  )

  return (
    <div
      ref={card}
      onContextMenu={(e) => {
        if (!act) return // nothing to offer, so no menu rather than an empty one
        e.preventDefault()
        e.stopPropagation()
        // The Menu key arrives as a contextmenu event at 0,0. Put the panel on the
        // card it belongs to rather than in the corner of the screen.
        const r = card.current?.getBoundingClientRect()
        if (e.clientX || e.clientY) onMenu(e.clientX, e.clientY)
        else onMenu(r ? r.left + 20 : 0, r ? r.top + 20 : 0)
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '11px 13px',
        minWidth: 280,
        maxWidth: 420,
        background: C.panel,
        border: `1px solid ${C.border3}`,
        borderLeft: `3px solid ${bad ? C.danger : C.accent}`,
        borderRadius: 10,
        boxShadow: C.shadowMenu,
        animation: 'cc-toast 0.25s ease',
      }}
    >
      {act ? (
        // A real button, so the tab stop, Enter and Space, and the focus ring all
        // come with it rather than being rebuilt on a div with role="button".
        <button
          type="button"
          className="cc-toast-body"
          title={openLabel(act.kind)}
          onClick={open}
          // No `background` here: an inline one would outrank the :hover rule in
          // styles.css and the lift would never show. It is set on the class.
          style={{
            ...bodyStyle,
            border: 'none',
            font: 'inherit',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          {inner}
        </button>
      ) : (
        // Spelled out rather than left to `auto`, which over text is an I-beam: a
        // card with nothing to open should look like a message, not a field.
        <div style={{ ...bodyStyle, cursor: 'default' }}>{inner}</div>
      )}
      {/* Always there, never revealed on hover: five seconds is no time at all to
          discover a control by pointing at it, and the card has the room. */}
      {act && <CardButton icon="folder" title={fileManagerVerb()} bad={bad} onClick={reveal} />}
      <CardButton icon="close" title="Dismiss" bad={bad} onClick={() => dismiss(toast.id)} />
    </div>
  )
}

export function Toasts(): React.JSX.Element | null {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const [over, setOver] = useState(false)
  const [focused, setFocused] = useState(false)

  // Held at the stack rather than per card, deliberately. Cards leave from a
  // bottom-anchored column, so one expiring above the card you are pointing at
  // would slide that card out from under the cursor — and the mouseleave that
  // followed would start its clock again, which is the opposite of what pausing
  // is for. Each card still spends its own budget and keeps its own ceiling, so
  // holding the stack can't make them expire together or live forever.
  const held = over || focused || menu !== null

  const target = menu ? toasts.find((t) => t.id === menu.id) : undefined

  // The card a menu belongs to can go away underneath it — its own cap, or an
  // action on another card pushing it out of the stack of four.
  useEffect(() => {
    if (menu && !target) setMenu(null)
  }, [menu, target])

  // The stack renders nothing when it empties, so the element holding the mouse
  // and focus listeners goes with it and neither mouseleave nor blur ever
  // arrives. Without this the hold stays latched — dismiss a card with the
  // pointer on it, or open one with Enter, and the *next* toast is born paused
  // and sits there for its full thirty seconds.
  useEffect(() => {
    if (toasts.length) return
    setOver(false)
    setFocused(false)
  }, [toasts.length])

  // A fresh array in a render would re-arm MenuPanel's document listeners on
  // every hover; the toast objects themselves are stable, so this memo holds.
  const nodes = useMemo(() => {
    const act = target?.action
    if (!target || !act) return []
    const fire = (run: (path: string) => void) => () => {
      run(act.path)
      dismiss(target.id)
    }
    return toastMenu(act, {
      open: fire((p) => void openAttachment(p)),
      reveal: fire((p) => void revealAttachment(p)),
    })
  }, [target, dismiss])

  if (!toasts.length) return null
  return (
    <>
      <div
        role="status"
        aria-live="polite"
        onMouseEnter={() => setOver(true)}
        onMouseLeave={() => setOver(false)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          // React's blur bubbles, so tabbing from the body to the folder button
          // would otherwise release the hold for a frame and restart the clock.
          if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false)
        }}
        style={{
          position: 'fixed',
          right: 20,
          bottom: 20,
          zIndex: 40,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {toasts.map((t) => (
          <Toast key={t.id} toast={t} held={held} onMenu={(x, y) => setMenu({ id: t.id, x, y })} />
        ))}
      </div>
      {/* Outside the stack, not inside it. A panel nested in the hovered element
          is still a DOM descendant however far across the screen it is painted,
          so the pointer moving onto it would never look like leaving — and the
          hold would stay stuck once the menu closed. MenuPanel is position:fixed,
          so being a sibling costs it nothing. */}
      {menu && nodes.length > 0 && (
        <MenuPanel
          key={`${menu.id}:${menu.x},${menu.y}`}
          nodes={nodes}
          place={{ kind: 'point', x: menu.x, y: menu.y }}
          isRoot
          onClose={() => setMenu(null)}
          onCloseAll={() => setMenu(null)}
        />
      )}
    </>
  )
}
