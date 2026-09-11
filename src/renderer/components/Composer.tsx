// The conversation view's input box.
//
// Claude's TUI owns the real one, so this doesn't replace it — it types into the
// same session's pty (see main/send-prompt.ts) and lets you drive a session
// without going back to the terminal to reply.
//
// Two rules shape it:
//   • It is never `disabled`. A disabled textarea can't take focus, and focus
//     inside the view is what the global Esc handler keys off (it looks for
//     `[data-conversation-for]` above the event target) — disabling the box for a
//     stopped session would strand the reader in a view whose only exit is the
//     mouse. What gets disabled is *sending*. It also means you can compose while
//     Claude sits on a permission dialog, go answer it, come back and press Enter.
//   • It never throws text away. The draft lives in the store, keyed by session,
//     so Esc to the terminal and back brings it with you, and a refused send
//     hands it back rather than swallowing it.

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Session } from '../../shared/types'
import { C, accentA, ink } from '../theme'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import { startFromSidebar } from '../menus'
import * as registry from '../term/registry'

/** How tall the box grows before it starts scrolling instead (~9 lines). */
const MAX_HEIGHT = 180

/** Why the composer can't send, and the one thing that would fix it. */
export interface Blocked {
  why: string
  action: 'relaunch' | 'terminal'
}

/**
 * Whether this session can be sent to right now.
 *
 * `waiting` is the interesting one: Claude is blocked on something the transcript
 * never contains — a permission request, a plan picker, `/model`, a y/n. Those
 * are drawn by the TUI and read keystrokes as menu selections, so a prompt pasted
 * into one could silently pick an option. They can't be answered from here at
 * all, so the honest answer is to say where they are and offer the trip.
 *
 * `busy` is deliberately *not* blocked: Claude queues what arrives mid-turn.
 */
export function blockedReason(session: Session): Blocked | null {
  if (!session.alive) {
    return {
      why: session.everStarted
        ? `${session.name} isn't running.`
        : `${session.name} hasn't been started yet.`,
      action: 'relaunch',
    }
  }
  if (session.status === 'waiting') {
    return {
      why: `${session.name} is asking something in its terminal — answer it there.`,
      action: 'terminal',
    }
  }
  return null
}

export function Composer({
  session,
  blocked,
  onSend,
  onHeight,
  onRelaunch,
  inputRef,
}: {
  session: Session
  blocked: Blocked | null
  onSend: (text: string) => void
  /** Called when the box's height changed, so the flow above can re-pin itself. */
  onHeight: () => void
  /** Relaunch was asked for *here*, so the caret should come back when it's up. */
  onRelaunch: () => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const sessionId = session.id
  const draft = useStore((s) => s.drafts[sessionId]) ?? ''
  const setDraft = useStore((s) => s.setDraft)
  const toggleTranscript = useStore((s) => s.toggleTranscript)
  const wrap = useRef<HTMLDivElement>(null)
  const lastHeight = useRef(0)
  const lastWidth = useRef(0)

  const canSend = !blocked && draft.trim() !== ''

  // Grow with the content up to the cap, then scroll. A layout effect, not an
  // effect: measuring after paint makes every keystroke flicker.
  const measure = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    const next = Math.min(el.scrollHeight, MAX_HEIGHT)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
    if (next !== lastHeight.current) {
      lastHeight.current = next
      onHeight()
    }
  }, [inputRef, onHeight])

  useLayoutEffect(measure, [measure, draft, blocked?.action])

  // A narrower pane re-wraps the text, which changes the height. Observe the
  // wrapper, never the textarea — measuring an element whose height you set from
  // the observation is a feedback loop.
  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (w === lastWidth.current) return
      lastWidth.current = w
      measure()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  const send = () => {
    if (!canSend) return
    onSend(draft)
  }

  const act = () => {
    if (blocked?.action === 'relaunch') {
      onRelaunch()
      startFromSidebar(sessionId)
    } else {
      toggleTranscript(sessionId)
      registry.focus(sessionId)
    }
  }

  return (
    <div
      ref={wrap}
      style={{
        flex: 'none',
        borderTop: `1px solid ${C.border}`,
        background: ink(0.02),
        padding: '10px 20px 12px',
      }}
    >
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        {blocked && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 8,
              padding: '7px 10px',
              borderRadius: 8,
              border: `1px solid ${C.border2}`,
              background: C.panel2,
              fontSize: 11.5,
              color: C.muted,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>{blocked.why}</span>
            <button
              onClick={act}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 7,
                border: `1px solid ${C.accentBorder}`,
                background: C.accentBg,
                color: C.accentSoft,
                font: 'inherit',
                fontSize: 11,
                cursor: 'pointer',
                flex: 'none',
              }}
            >
              <Icon name={blocked.action === 'relaunch' ? 'power' : 'terminal'} size={12} />
              {blocked.action === 'relaunch' ? 'Relaunch' : 'Go to terminal'}
            </button>
          </div>
        )}

        <div
          className="cv-composer"
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 8,
            padding: '8px 10px',
            background: C.input,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: blocked ? C.border2 : C.border3,
            borderRadius: 10,
          }}
        >
          <textarea
            ref={inputRef}
            rows={1}
            spellCheck={false}
            // Not `disabled`, and not `aria-disabled` either: the box really is
            // typeable while blocked — you can write the next message, go answer
            // the dialog, and come back to send it. It's the button below that
            // can't act, and it says so itself.
            placeholder={blocked ? `Can’t send yet — ${session.name} is busy elsewhere` : `Message ${session.name}…`}
            value={draft}
            onChange={(e) => setDraft(sessionId, e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line. isComposing keeps an
              // IME candidate selection from submitting the half-typed word.
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
              if (e.altKey || e.ctrlKey || e.metaKey) return
              e.preventDefault()
              send()
            }}
            style={{
              flex: 1,
              minWidth: 0,
              maxHeight: MAX_HEIGHT,
              resize: 'none',
              padding: 0,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: blocked ? C.muted : C.textHi,
              font: 'inherit',
              fontSize: 12.5,
              lineHeight: 1.55,
            }}
          />
          <button
            onClick={send}
            disabled={!canSend}
            title={blocked ? blocked.why : 'Send (Enter)'}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 7,
              border: 'none',
              background: canSend ? C.accent : accentA(0.12),
              color: canSend ? C.accentText : C.faint2,
              cursor: canSend ? 'pointer' : 'default',
              flex: 'none',
            }}
          >
            <Icon name="send" size={13} />
          </button>
        </div>

        <div style={{ marginTop: 5, fontSize: 10, color: C.faint2 }}>
          {session.status === 'busy' && !blocked
            ? 'Claude is working — a message sent now is queued for when the turn ends.'
            : 'Enter to send · Shift+Enter for a new line'}
        </div>
      </div>
    </div>
  )
}
