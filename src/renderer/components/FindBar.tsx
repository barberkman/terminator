import { C, sz } from '../theme'
import { Icon } from '../icons'
import type { FindHits } from '../find'

/**
 * The find bar, shared by the conversation view and the in-app browser pane.
 *
 * Presentational only — it knows nothing about how matches are found, which is
 * the one thing the two views genuinely can't share. One searches DOM this
 * renderer owns; the other asks Chromium about a page in a <webview>. What they
 * do share is this: the box, the counter, and what the keys in it mean.
 *
 * It floats over the pane rather than taking a row in the chrome. A row would
 * push the page down every time the bar opened — in the browser pane that means
 * re-laying-out the guest, which is the one thing a find is supposed not to do
 * to what you're reading.
 */
export function FindBar({
  query,
  onQuery,
  hits,
  onNext,
  onPrev,
  onClose,
  inputRef,
  hint,
}: {
  query: string
  onQuery: (q: string) => void
  hits: FindHits
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  inputRef?: React.RefObject<HTMLInputElement | null>
  /** Anything the view wants to say under the box — see the conversation's. */
  hint?: React.ReactNode
}): React.JSX.Element {
  const empty = !!query && !hits.total

  return (
    <div
      // The conversation's own search walks the DOM for text, and the words in
      // this box are not part of the conversation.
      data-find-skip
      style={{
        position: 'absolute',
        top: 8,
        right: 14,
        zIndex: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '7px 8px',
        borderRadius: 9,
        border: `1px solid ${C.border2}`,
        background: C.panel,
        boxShadow: C.shadowMenu,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (e.shiftKey) onPrev()
              else onNext()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              onNext()
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              onPrev()
            } else if (e.key === 'Escape') {
              // Esc here means "close the bar", never "leave the view". Without
              // this, App.tsx's Escape chain walks up to [data-conversation-for]
              // and drops the whole conversation back to its terminal. The
              // browser pane's address bar makes the same move for the same
              // reason.
              e.stopPropagation()
              onClose()
            }
          }}
          spellCheck={false}
          placeholder="Find"
          aria-label="Find"
          style={{
            width: sz(150),
            minWidth: 0,
            padding: '4px 8px',
            background: C.input,
            // Longhand, never the `border` shorthand: these are var() references
            // and a shorthand holding one is dropped rather than updated when the
            // colour changes with the no-matches state.
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: empty ? C.danger : C.border2,
            borderRadius: 7,
            color: C.textHi,
            font: 'inherit',
            fontSize: 11.5,
            outline: 'none',
          }}
        />
        <span
          style={{
            minWidth: sz(34),
            textAlign: 'right',
            fontSize: 10.5,
            fontVariantNumeric: 'tabular-nums',
            color: empty ? C.danger : C.dim,
          }}
        >
          {query ? `${hits.index}/${hits.total}` : ''}
        </span>
        <StepButton label="Previous match" up disabled={!hits.total} onClick={onPrev} />
        <StepButton label="Next match" disabled={!hits.total} onClick={onNext} />
        <StepButton label="Close (Esc)" close onClick={onClose} />
      </div>
      {hint}
    </div>
  )
}

/** The bar's three controls. Chevrons rather than a new icon: up is the one we have, turned. */
function StepButton({
  label,
  onClick,
  disabled,
  up,
  close,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  up?: boolean
  close?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: sz(22),
        height: sz(22),
        flex: 'none',
        borderRadius: 6,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'transparent',
        background: 'transparent',
        color: disabled ? C.faint : C.textSubtle,
        cursor: disabled ? 'default' : 'pointer',
        outline: 'none',
      }}
    >
      <span style={{ display: 'flex', transform: up ? 'rotate(180deg)' : undefined }}>
        <Icon name={close ? 'close' : 'chevron'} size={12} />
      </span>
    </button>
  )
}
