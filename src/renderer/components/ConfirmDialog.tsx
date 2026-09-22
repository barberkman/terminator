import { isProcessless } from '../../shared/types'
import { C, dangerA } from '../theme'
import { aboutOneSession, useStore } from '../state/store'

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
        background: C.scrim,
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
          boxShadow: C.shadowModal,
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
              color: C.textBtn,
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
              background: dangerA(0.16),
              border: `1px solid ${dangerA(0.4)}`,
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

/**
 * Take a whole group out, one session at a time.
 *
 * Backwards through sidebar order, because `order` keeps a branch after its
 * parent: taking the children first means main never re-parents a subtree onto a
 * grandparent it is about to delete anyway — a round of sessionUpdated events
 * and a persisted tree that exists for one tick.
 *
 * A session's worktree goes before the session, because main resolves the path
 * from the session it is about to forget; remove the session first and the
 * directory is left behind with nothing pointing at it. And a worktree git
 * refuses to delete must not keep the other rows in the sidebar — you asked for
 * them to go, so they go, and the toast is where the leftover is reported.
 *
 * Awaited one at a time so that ordering is real rather than a hope about
 * scheduling; main coalesces the saves behind it either way.
 */
async function removeGroup(ids: string[], worktrees: boolean): Promise<void> {
  for (const id of [...ids].reverse()) {
    const s = useStore.getState().sessions[id]
    if (!s) continue
    const path = s.worktreePath
    if (worktrees && path) {
      await window.terminator.removeWorktree(id).catch(() =>
        useStore
          .getState()
          .pushToast({ tone: 'error', text: 'Worktree left behind', sub: path, icon: 'branch' }),
      )
    }
    await window.terminator.removeSession(id)
  }
}

export function ConfirmDialog(): React.JSX.Element | null {
  const confirm = useStore((s) => s.confirm)
  const setConfirm = useStore((s) => s.setConfirm)
  // Only the one-session prompts have an id to look up; ask for nothing on the
  // ones that don't, rather than reading `.id` off a shape that hasn't got one.
  const sessionId = confirm && aboutOneSession(confirm) ? confirm.id : ''
  const worktreePath = useStore((s) => (sessionId ? s.sessions[sessionId]?.worktreePath : undefined))
  const kind = useStore((s) => (sessionId ? s.sessions[sessionId]?.kind : undefined))
  // A group prompt is about a list, so it needs every member's kind and worktree
  // rather than one session's. Derived below rather than in the selector, for
  // the reason buildGroups spells out: a fresh array from a selector loops.
  const all = useStore((s) => s.sessions)
  if (!confirm) return null

  const close = () => setConfirm(null)

  if (confirm.kind === 'browserClear') {
    const signOut = confirm.what === 'cookies'
    return (
      <Dialog
        title={signOut ? 'Sign out of everything?' : 'Clear everything?'}
        body={
          signOut
            ? "Drop every cookie the in-app browser is holding. You'll be signed out of Claude in it, and of anything else you signed into there, until you sign in again."
            : "Drop everything the in-app browser is holding: cookies, every site's stored data, and the cache. It goes back to how it was before you first opened a page in it."
        }
        confirmLabel={signOut ? 'Sign out' : 'Clear everything'}
        cancelLabel="Cancel"
        onConfirm={async () => {
          await window.terminator.clearBrowserData(confirm.what)
          close()
        }}
        onCancel={close}
      />
    )
  }

  // Everything that isn't about exactly one session is about a whole group, in
  // two steps. Asked through the predicate rather than by listing the two group
  // kinds, because that is what leaves the one-session prompts below narrowed:
  // a discriminant that is itself a union of literals doesn't narrow away.
  if (!aboutOneSession(confirm)) {
    const group = confirm.ids.map((x) => all[x]).filter((x) => x)
    const n = group.length
    const one = n === 1 ? group[0] : undefined
    // What Stop is about: an editor or browser pane has no process, the same
    // distinction the single prompt makes. `alive` is not the test — a stopped
    // Claude session is still something "stop and remove" describes.
    const running = group.filter((x) => !isProcessless(x.kind)).length
    const wts = group.filter((x) => x.worktreePath)
    const w = wts.length
    // Closed before the work starts, unlike the single flow: the removals arrive
    // one at a time, and a prompt left up would re-word itself as its own
    // sessions disappear underneath it.
    const done = (withWorktrees: boolean): void => {
      close()
      void removeGroup(confirm.ids, withWorktrees)
    }

    // The worktrees, asked once. It is the same question every time — have you
    // merged this? — and a stack of identical modals is a thing to click past,
    // which is the opposite of what a confirmation is for. Only the prompt below
    // opens this one, so the sessions are going either way and both buttons say so.
    if (confirm.kind === 'worktreeGroup') {
      const wt = w === 1 ? wts[0] : undefined
      return (
        <Dialog
          title={wt ? 'Remove worktree?' : `Remove ${w} git worktrees?`}
          body={
            (wt
              ? `Delete the git worktree for “${wt.name}”${wt.worktreePath ? ` at ${wt.worktreePath}` : ''}?`
              : `Delete the ${w} git worktrees the sessions in “${confirm.name}” are working in?`) +
            " Make sure you've merged any work first." +
            (n === 1 ? ' The session is removed either way.' : ` All ${n} sessions are removed either way.`)
          }
          confirmLabel={wt ? 'Remove worktree' : 'Remove worktrees'}
          cancelLabel={wt ? 'Keep worktree' : 'Keep worktrees'}
          onConfirm={() => done(true)}
          onCancel={() => done(false)}
        />
      )
    }

    return (
      <Dialog
        title={n === 1 ? 'Remove session?' : 'Remove all sessions?'}
        // A group of one is worded exactly like the row's own prompt: this
        // describes what will happen, not which menu you arrived from.
        body={
          (one
            ? isProcessless(one.kind)
              ? `Remove “${one.name}” from the list.`
              : `Stop “${one.name}” and remove it from the list.`
            : running === 0
              ? `Remove all ${n} sessions in “${confirm.name}” from the list.`
              : running === n
                ? `Stop all ${n} sessions in “${confirm.name}” and remove them from the list.`
                : `Stop ${running} of the ${n} sessions in “${confirm.name}” and remove them all from the list.`) +
          (!w
            ? ''
            : one
              ? " You'll be asked about its git worktree next."
              : ` You'll be asked about ${w === 1 ? 'the one git worktree' : `the ${w} git worktrees`} next.`)
        }
        confirmLabel={n === 1 ? 'Remove' : 'Remove all'}
        cancelLabel="Cancel"
        onConfirm={() => {
          if (w) setConfirm({ kind: 'worktreeGroup', name: confirm.name, ids: confirm.ids })
          else done(false)
        }}
        onCancel={close}
      />
    )
  }

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
      // An editor or browser pane has no process, so offering to stop one would be
      // describing something that isn't going to happen.
      body={
        (kind && isProcessless(kind)
          ? `Remove “${name}” from the list.`
          : `Stop “${name}” and remove it from the list.`) +
        (worktreePath ? " You'll be asked about its git worktree next." : '')
      }
      confirmLabel={confirm.kind === 'close' ? 'Close' : 'Remove'}
      cancelLabel="Cancel"
      onConfirm={removeFlow}
      onCancel={close}
    />
  )
}
