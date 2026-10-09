import { useEffect, useRef, useState } from 'react'
import type { Session } from '../../shared/types'
import { hostFolder, sessionFolder } from '../../shared/wsl-path'
import { C, dangerA, sz } from '../theme'
import { Icon } from '../icons'
import { useEditorStore, type TabStatus } from '../editor/editorStore'
import * as editor from '../editor/registry'
import { sendBack, usePromptEdits } from '../promptEdit'
import { FileTree } from './FileTree'
import { QuickOpen, useQuickOpenKeys } from './QuickOpen'
import { useStore } from '../state/store'

const MIN_TREE = 150
const MAX_TREE = 520
/** Width of the rail the file tree folds down to. */
const TREE_RAIL = 30
/** Stable empty array so the zustand selector doesn't return a fresh ref each render. */
const NO_TABS: string[] = []

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p
}

const STATUS_MESSAGE: Record<Exclude<TabStatus, 'ok'>, string> = {
  binary: "This looks like a binary file — it can't be edited here.",
  tooLarge: 'This file is too large to open (over 2 MB).',
  missing: 'This file no longer exists on disk.',
}

/** The file tree's hide/show button: the same quiet square as a tab's ✕. */
function TreeToggle({ sessionId, hidden, style }: { sessionId: string; hidden: boolean; style?: React.CSSProperties }): React.JSX.Element {
  return (
    <button
      onClick={() => useEditorStore.getState().setTreeHidden(sessionId, !hidden)}
      title={hidden ? 'Show files' : 'Hide files'}
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
        ...style,
      }}
    >
      <Icon name="sidebar" size={13} />
    </button>
  )
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
      onDoubleClick={() => editor.pinTab(sessionId, path)}
      // Middle-click closes, as in a browser. Taken at mousedown too, or Chromium starts
      // autoscrolling the tab bar (and Linux pastes the primary selection).
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault()
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        editor.closeTab(sessionId, path)
      }}
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
      {/* Italic marks a preview tab, as in VS Code: the next file opened from the tree replaces it. */}
      <span
        style={{
          fontSize: 12,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontStyle: tab.preview ? 'italic' : 'normal',
        }}
      >
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
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}

/**
 * Banner shown above a tab holding a prompt that a Claude session is blocked on
 * (see renderer/promptEdit.ts). It is the only thing on screen that knows the
 * session is waiting, which is why it also spells out what closing the tab does —
 * that is a way out, not an accident, and both routes hand the prompt back.
 */
function PromptBanner({ file }: { file: string }): React.JSX.Element {
  const edit = usePromptEdits((s) => s.edits[file])
  if (!edit) return <></>
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
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <strong style={{ fontWeight: 600 }}>{edit.sessionName}</strong> is waiting for this.
      </span>
      <button
        onClick={() => void sendBack(file)}
        style={{ padding: '3px 10px', borderRadius: 6, border: `1px solid ${C.accentBorder}`, background: 'transparent', color: C.accentSoft, font: 'inherit', fontSize: 11.5, cursor: 'pointer', flex: 'none' }}
      >
        Send it back
      </button>
      <span style={{ color: C.muted, fontSize: 11, flex: 'none' }}>
        or close the tab to leave the prompt as it was
      </span>
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
      <PromptBanner file={activePath} />
      {tab.changedOnDisk && <ChangedBanner sessionId={sessionId} path={activePath} />}
      {tab.status === 'missing' && hasView && (
        <div style={{ padding: '7px 12px', background: dangerA(0.12), borderBottom: `1px solid ${C.border3}`, fontSize: 12, color: C.danger }}>
          Deleted on disk — save to recreate it.
        </div>
      )}
      {hasView ? (
        // `isolation` keeps CodeMirror's own layers (gutters, tooltips: z-index up to 500)
        // stacked in here, so Quick Open above the editor doesn't have to outbid them.
        <div ref={hostRef} onMouseDown={() => activePath && editor.focusTab(sessionId, activePath)} style={{ flex: 1, minHeight: 0, overflow: 'hidden', isolation: 'isolate' }} />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: C.dim, fontSize: 12.5 }}>
          {STATUS_MESSAGE[tab.status as Exclude<TabStatus, 'ok'>] ?? 'Unable to open this file.'}
        </div>
      )}
    </div>
  )
}

export function EditorPaneBody({ session }: { session: Session }): React.JSX.Element {
  // The folder as the file service reads it: a WSL session's through its distro's
  // share. Main resolves the same root from the session id (ipc.ts editorRoot), so
  // the paths the tree builds and the paths main accepts are one and the same.
  const root = hostFolder(session)
  const sessionId = session.id
  const [treeWidth, setTreeWidth] = useState(240)
  const openPaths = useEditorStore((s) => s.sessions[sessionId]?.openPaths ?? NO_TABS)
  const activePath = useEditorStore((s) => s.sessions[sessionId]?.activePath ?? null)
  const treeHidden = useEditorStore((s) => s.sessions[sessionId]?.treeHidden ?? false)
  const focusedHere = useStore((s) => s.panes[s.focused] === sessionId)
  const [quickOpen, setQuickOpen] = useState(false)
  useQuickOpenKeys(focusedHere, () => setQuickOpen(true))
  const closeQuickOpen = (refocus: boolean): void => {
    setQuickOpen(false)
    const p = useEditorStore.getState().sessions[sessionId]?.activePath
    if (refocus && p) editor.focusTab(sessionId, p)
  }

  // Previews turned off in Settings: a preview tab left from before is kept like any
  // other, since nothing will come along to replace it now.
  const previewTabs = useStore((s) => s.settings?.editorPreviewTabs ?? true)
  useEffect(() => {
    if (previewTabs) return
    const s = useEditorStore.getState().sessions[sessionId]
    const p = s?.openPaths.find((x) => s.tabs[x]?.preview)
    if (p) editor.pinTab(sessionId, p)
  }, [previewTabs, sessionId])

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
      {/* Folded file tree */}
      {treeHidden && (
        <div style={{ width: TREE_RAIL, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6, background: C.sidebar, borderRight: `1px solid ${C.border}` }}>
          <TreeToggle sessionId={sessionId} hidden />
        </div>
      )}

      {/* File tree — kept mounted while folded, so it comes back where it was scrolled to */}
      <div style={{ width: treeWidth, flex: 'none', minWidth: 0, display: treeHidden ? 'none' : 'flex', flexDirection: 'column', background: C.sidebar, borderRight: `1px solid ${C.border}` }}>
        <div style={{ padding: '9px 12px 7px', fontSize: 10.5, letterSpacing: 0.6, color: C.dim, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ display: 'flex', color: C.kindIcon }}>
            <Icon name="folder" size={12} />
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{basename(sessionFolder(session)).toUpperCase()}</span>
          {/* Negative margins so the button doesn't make the header any taller. */}
          <TreeToggle sessionId={sessionId} hidden={false} style={{ margin: '-3px -6px -3px 0' }} />
        </div>
        <FileTree sessionId={sessionId} root={root} />
      </div>

      {/* Drag handle */}
      {!treeHidden && (
        <div
          onMouseDown={startResize}
          style={{ width: 5, flex: 'none', cursor: 'col-resize', background: 'transparent', marginLeft: -3, marginRight: -2, zIndex: 1 }}
        />
      )}

      {/* Tabs + editor */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {quickOpen && <QuickOpen sessionId={sessionId} root={root} onClose={closeQuickOpen} />}
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
