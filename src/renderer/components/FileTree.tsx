import { C } from '../theme'
import { Icon } from '../icons'
import { useEditorStore } from '../editor/editorStore'
import * as editor from '../editor/registry'

/** Join a directory and a child name with a POSIX separator (the app targets Linux). */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

function Row({
  depth,
  isDir,
  expanded,
  name,
  active,
  onClick,
}: {
  depth: number
  isDir: boolean
  expanded: boolean
  name: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <div
      className="cc-row"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingLeft: 8 + depth * 12,
        paddingRight: 8,
        height: 24,
        borderRadius: 6,
        cursor: 'pointer',
        color: active ? C.textHi : C.body,
        background: active ? C.accentBg : 'transparent',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      <span style={{ display: 'flex', width: 12, flex: 'none', color: C.muted }}>
        {isDir && (
          <span style={{ display: 'flex', transform: expanded ? 'none' : 'rotate(-90deg)', transition: 'transform 0.1s ease' }}>
            <Icon name="chevron" size={12} />
          </span>
        )}
      </span>
      <span style={{ display: 'flex', flex: 'none', color: isDir ? C.kindIcon : C.muted }}>
        <Icon name={isDir ? 'folder' : 'file'} size={13} />
      </span>
      <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
    </div>
  )
}

function TreeNode({
  sessionId,
  path,
  name,
  isDir,
  depth,
}: {
  sessionId: string
  path: string
  name: string
  isDir: boolean
  depth: number
}): React.JSX.Element {
  const expanded = useEditorStore((s) => !!s.sessions[sessionId]?.expanded[path])
  const entries = useEditorStore((s) => s.sessions[sessionId]?.listings[path])
  const active = useEditorStore((s) => s.sessions[sessionId]?.activePath === path)

  const onClick = () => {
    if (isDir) {
      if (expanded) editor.collapseDir(sessionId, path)
      else void editor.expandDir(sessionId, path)
    } else {
      void editor.openFile(sessionId, path, name)
    }
  }

  return (
    <>
      <Row depth={depth} isDir={isDir} expanded={expanded} name={name} active={active} onClick={onClick} />
      {isDir &&
        expanded &&
        entries?.map((e) => (
          <TreeNode
            key={e.name}
            sessionId={sessionId}
            path={joinPath(path, e.name)}
            name={e.name}
            isDir={e.isDir}
            depth={depth + 1}
          />
        ))}
    </>
  )
}

/** Lazy file tree rooted at the session's project folder. */
export function FileTree({ sessionId, root }: { sessionId: string; root: string }): React.JSX.Element {
  const rootEntries = useEditorStore((s) => s.sessions[sessionId]?.listings[root])

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 4px 8px' }}>
      {rootEntries === undefined ? (
        <div style={{ padding: '10px 12px', fontSize: 11.5, color: C.dim }}>Loading…</div>
      ) : rootEntries.length === 0 ? (
        <div style={{ padding: '10px 12px', fontSize: 11.5, color: C.dim }}>Empty folder</div>
      ) : (
        rootEntries.map((e) => (
          <TreeNode
            key={e.name}
            sessionId={sessionId}
            path={joinPath(root, e.name)}
            name={e.name}
            isDir={e.isDir}
            depth={0}
          />
        ))
      )}
    </div>
  )
}
