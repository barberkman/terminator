import { C } from '../theme'
import { useStore } from '../state/store'

interface DialogProps {
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
}

function Dialog({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }: DialogProps): React.JSX.Element {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 55,
        background: 'rgba(10,9,8,0.66)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'cc-fade 0.18s ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 382,
          maxWidth: '92vw',
          background: C.panel,
          border: `1px solid ${C.border3}`,
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          padding: '22px 22px 18px',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: C.textMax, marginBottom: 9 }}>{title}</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.6, color: C.body, marginBottom: 20 }}>{body}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
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
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '10px 18px',
              background: 'rgba(207,94,78,0.16)',
              border: `1px solid rgba(207,94,78,0.4)`,
              borderRadius: 9,
              color: C.danger,
              font: 'inherit',
              fontSize: 12.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmDialog(): React.JSX.Element | null {
  const confirm = useStore((s) => s.confirm)
  const setConfirm = useStore((s) => s.setConfirm)
  const worktreePath = useStore((s) => (confirm ? s.sessions[confirm.id]?.worktreePath : undefined))
  if (!confirm) return null

  const close = () => setConfirm(null)
  const { id, name } = confirm

  // Worktree prompt — shown on its own, or after a close/remove (removeAfter).
  if (confirm.kind === 'worktree') {
    const removeAfter = !!confirm.removeAfter
    return (
      <Dialog
        title="Remove worktree?"
        body={`Delete the git worktree for “${name}”${worktreePath ? ` at ${worktreePath}` : ''}? Make sure you've merged any work first.`}
        confirmLabel="Remove worktree"
        cancelLabel={removeAfter ? 'Keep worktree' : 'Cancel'}
        onConfirm={async () => {
          await window.terminator.removeWorktree(id)
          if (removeAfter) void window.terminator.removeSession(id)
          close()
        }}
        onCancel={() => {
          if (removeAfter) void window.terminator.removeSession(id)
          close()
        }}
      />
    )
  }

  // close / remove — both take the session out of the sidebar (so an emptied
  // project group disappears). If it has a worktree, offer to remove that next.
  const removeFlow = () => {
    if (worktreePath) {
      setConfirm({ kind: 'worktree', id, name, removeAfter: true })
    } else {
      void window.terminator.removeSession(id)
      close()
    }
  }
  return (
    <Dialog
      title={confirm.kind === 'close' ? 'Close session?' : 'Remove session?'}
      body={
        worktreePath
          ? `Stop “${name}” and remove it from the list. You'll be asked about its git worktree next.`
          : `Stop “${name}” and remove it from the list.`
      }
      confirmLabel={confirm.kind === 'close' ? 'Close' : 'Remove'}
      cancelLabel="Cancel"
      onConfirm={removeFlow}
      onCancel={close}
    />
  )
}
