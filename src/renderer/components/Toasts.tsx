import { useEffect } from 'react'
import { type ToastItem, useStore } from '../state/store'
import { C, accentA, dangerA } from '../theme'
import { Icon } from '../icons'

// The app's only transient message surface. Attachments need one in both
// directions: a terminal can't show you the screenshot you just pasted, and a
// drop that couldn't be attached has nowhere else to say why.

const TTL = { ok: 5000, error: 11000 }

function Toast({ toast }: { toast: ToastItem }): React.JSX.Element {
  const dismiss = useStore((s) => s.dismissToast)
  const bad = toast.tone === 'error'

  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), TTL[toast.tone])
    return () => clearTimeout(t)
  }, [toast.id, toast.tone, dismiss])

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
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
          <Icon name={bad ? 'close' : 'paperclip'} size={15} />
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
      <button
        onClick={() => dismiss(toast.id)}
        title="Dismiss"
        style={{
          flex: 'none',
          display: 'flex',
          padding: 4,
          borderRadius: 6,
          border: 'none',
          background: bad ? dangerA(0.12) : accentA(0.1),
          color: C.muted,
          cursor: 'pointer',
        }}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}

export function Toasts(): React.JSX.Element | null {
  const toasts = useStore((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div
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
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  )
}
