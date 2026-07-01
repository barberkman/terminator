import { useEffect, useRef, useState } from 'react'
import type { Session } from '../../shared/types'
import { C } from '../theme'
import { Icon } from '../icons'
import { useEditorStore, type TabStatus } from '../editor/editorStore'
import * as editor from '../editor/registry'
import { FileTree } from './FileTree'

const MIN_TREE = 150
const MAX_TREE = 520
/** Stable empty array so the zustand selector doesn't return a fresh ref each render. */
const NO_TABS: string[] = []

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

const STATUS_MESSAGE: Record<Exclude<TabStatus, 'ok'>, string> = {
  binary: "This looks like a binary file — it can't be edited here.",
  tooLarge: 'This file is too large to open (over 2 MB).',
  missing: 'This file no longer exists on disk.',
}

/** A single tab in the tab bar. */
function Tab({
  sessionId,
  path,
  active,
}: {
  sessionId: string
  path: string
  active: boolean
}): React.JSX.Element {
  const tab = useEditorStore((s) => s.sessions[sessionId]?.tabs[path])
  if (!tab) return <></>
  return (
    <div
      onClick={() => editor.setActive(sessionId, path)}
      title={path}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '0 8px 0 11px',
        height: 34,
        flex: 'none',
        maxWidth: 200,
        cursor: 'pointer',
        borderRight: `1px solid ${C.border}`,
        background: active ? C.bg : 'transparent',
        borderTop: active ? `1.5px solid ${C.accent}` : '1.5px solid transparent',
        color: active ? C.textHi : C.muted,
      }}
    >
      <span style={{ display: 'flex', flex: 'none', color: tab.changedOnDisk ? C.accent : C.faint }}>
        <Icon name="file" size={12} />
      </span>
      <span style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {tab.name}
      </span>
      {tab.dirty ? (
        <span
          title="Unsaved changes"
          style={{ width: 7, height: 7, borderRadius: '50%', background: C.accentSoft, flex: 'none' }}
        />
      ) : null}
      <button
        onClick={(e) => {
          e.stopPropagation()
          editor.closeTab(sessionId, path)
        }}
        title="Close tab"
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
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}

/** Banner shown above the editor when the open file changed on disk under unsaved edits. */
function ChangedBanner({ sessionId, path }: { sessionId: string; path: string }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 12px',
        background: C.accentBg,
        borderBottom: `1px solid ${C.accentBorder}`,
        fontSize: 12,
        color: C.accentSoft,
      }}
    >
      <span>Changed on disk since you started editing.</span>
      <button
        onClick={() => void editor.reloadTab(sessionId, path)}
        style={{ padding: '3px 10px', borderRadius: 6, border: `1px solid ${C.accentBorder}`, background: 'transparent', color: C.accentSoft, font: 'inherit', fontSize: 11.5, cursor: 'pointer' }}
      >
        Reload from disk
      </button>
      <button
        onClick={() => useEditorStore.getState().patchTab(sessionId, path, { changedOnDisk: false })}
        style={{ padding: '3px 10px', borderRadius: 6, border: `1px solid ${C.border3}`, background: 'transparent', color: C.muted, font: 'inherit', fontSize: 11.5, cursor: 'pointer' }}
      >
        Keep mine
      </button>
    </div>
  )
}

/** The editor area for the active tab: the CodeMirror mount host, or a status message. */
function EditorArea({ sessionId, activePath }: { sessionId: string; activePath: string | null }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const tab = useEditorStore((s) => (activePath ? s.sessions[sessionId]?.tabs[activePath] : undefined))
  const hasView = activePath ? editor.hasView(sessionId, activePath) : false

  useEffect(() => {
    const el = hostRef.current
    if (!el || !activePath || !hasView) return
    editor.mountTab(sessionId, activePath, el)
    return () => editor.parkTab(sessionId, activePath)
  }, [sessionId, activePath, hasView])

  if (!activePath || !tab) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12.5 }}>
        Select a file to edit
      </div>
    )
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {tab.changedOnDisk && <ChangedBanner sessionId={sessionId} path={activePath} />}
      {tab.status === 'missing' && hasView && (
        <div style={{ padding: '7px 12px', background: 'rgba(207,94,78,0.12)', borderBottom: `1px solid ${C.border3}`, fontSize: 12, color: C.danger }}>
          Deleted on disk — save to recreate it.
        </div>
      )}
      {hasView ? (
        <div ref={hostRef} onMouseDown={() => activePath && editor.focusTab(sessionId, activePath)} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: C.dim, fontSize: 12.5 }}>
          {STATUS_MESSAGE[tab.status as Exclude<TabStatus, 'ok'>] ?? 'Unable to open this file.'}
        </div>
      )}
    </div>
  )
}

export function EditorPaneBody({ session }: { session: Session }): React.JSX.Element {
  const root = session.worktreePath || session.projectPath
  const sessionId = session.id
  const [treeWidth, setTreeWidth] = useState(240)
  const openPaths = useEditorStore((s) => s.sessions[sessionId]?.openPaths ?? NO_TABS)
  const activePath = useEditorStore((s) => s.sessions[sessionId]?.activePath ?? null)

  // Load + watch the root once; keep-alive state lives in the editor registry/store,
  // so this only kicks off initial listing (idempotent) — it is NOT torn down on
  // unmount (that would kill open tabs on a layout change). Disposal happens when
  // the session is removed (store.remove → editor.disposeSession).
  useEffect(() => {
    editor.initSession(sessionId, root)
  }, [sessionId, root])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = treeWidth
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(MAX_TREE, Math.max(MIN_TREE, startW + (ev.clientX - startX)))
      setTreeWidth(w)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', background: C.bg }}>
      {/* File tree */}
      <div style={{ width: treeWidth, flex: 'none', minWidth: 0, display: 'flex', flexDirection: 'column', background: C.sidebar, borderRight: `1px solid ${C.border}` }}>
        <div style={{ padding: '9px 12px 7px', fontSize: 10.5, letterSpacing: 0.6, color: C.dim, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ display: 'flex', color: C.kindIcon }}>
            <Icon name="folder" size={12} />
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{basename(root).toUpperCase()}</span>
        </div>
        <FileTree sessionId={sessionId} root={root} />
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={startResize}
        style={{ width: 5, flex: 'none', cursor: 'col-resize', background: 'transparent', marginLeft: -3, marginRight: -2, zIndex: 1 }}
      />

      {/* Tabs + editor */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {openPaths.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'stretch', height: 34, flex: 'none', background: C.footer, borderBottom: `1px solid ${C.border}`, overflowX: 'auto' }}>
            {openPaths.map((p) => (
              <Tab key={p} sessionId={sessionId} path={p} active={p === activePath} />
            ))}
          </div>
        )}
        <EditorArea sessionId={sessionId} activePath={activePath} />
      </div>
    </div>
  )
}
