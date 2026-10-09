import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileListResult } from '../../shared/types'
import { C } from '../theme'
import { Icon } from '../icons'
import { useEditorStore } from '../editor/editorStore'
import * as editor from '../editor/registry'
import { fuzzyMatch } from '../editor/fuzzy'
import { matchesAccelerator } from '../shortcuts'
import { modalOpen, useStore } from '../state/store'
import { inputStyle } from './controls'
import { joinPath } from './FileTree'

// An Editor pane's Quick Open — VS Code's Ctrl+P. Type part of a file's name, pick
// it, and it opens as a tab that stays. The list is every file under the pane's
// root that git doesn't ignore (main's `listFiles`), fetched each time it opens so
// it's never stale, and matched here as you type (editor/fuzzy.ts).

/** Rows shown at most. Past this the answer is a better query, not a longer scroll. */
const MAX_ROWS = 50
const NO_TABS: string[] = []

interface Row {
  rel: string
  positions: number[]
}

/**
 * `foo.ts:42` is the file and line 42, as VS Code's Quick Open reads it. A bare trailing
 * `:` is a line on its way, so the list doesn't empty out while you type it.
 */
function splitLine(query: string): { text: string; line?: number } {
  const m = /^(.*?):(\d*)\s*$/.exec(query)
  if (!m || !m[1].trim()) return { text: query }
  return { text: m[1], line: m[2] ? Number(m[2]) : undefined }
}

/** `text` with the characters at `hits` (offset by `from`) picked out. */
function Marked({ text, from, hits }: { text: string; from: number; hits: Set<number> }): React.JSX.Element {
  const out: React.ReactNode[] = []
  let run = ''
  let on = false
  const flush = (k: number): void => {
    if (!run) return
    out.push(
      on ? (
        <span key={k} style={{ color: C.accentSoft, fontWeight: 600 }}>
          {run}
        </span>
      ) : (
        run
      ),
    )
    run = ''
  }
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(from + i)
    if (hit !== on) {
      flush(i)
      on = hit
    }
    run += text[i]
  }
  flush(text.length)
  return <>{out}</>
}

/**
 * Bind the Quick Open shortcut while `active` — the pane is an Editor pane and the
 * focused one. Modelled on `useFindKeys` (find.ts): capture phase, so it comes before
 * CodeMirror, and bound only while it applies, so in a terminal pane the key still
 * reaches the program (Ctrl+P is bash's previous-history). The shortcut is read at the
 * keypress, so a new one from Settings works as soon as it's saved.
 */
export function useQuickOpenKeys(active: boolean, onOpen: () => void): void {
  const open = useRef(onOpen)
  open.current = onOpen
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      const accel = useStore.getState().settings?.quickOpenShortcut ?? ''
      if (!accel || !matchesAccelerator(e, accel)) return
      // Also what keeps recording the shortcut in Settings from opening this.
      if (modalOpen()) return
      if ((document.activeElement as HTMLElement | null)?.closest('.xterm')) return
      e.preventDefault()
      e.stopPropagation()
      open.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])
}

/**
 * The box itself. `onClose(refocus)`: true when it was dismissed with Esc, which hands
 * focus back to the editor; false when focus went somewhere on purpose — a click
 * elsewhere, or a pick, which focuses the file it opened.
 */
export function QuickOpen({
  sessionId,
  root,
  onClose,
}: {
  sessionId: string
  root: string
  onClose: (refocus: boolean) => void
}): React.JSX.Element {
  const [list, setList] = useState<FileListResult | null>(null)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const openPaths = useEditorStore((s) => s.sessions[sessionId]?.openPaths ?? NO_TABS)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    window.terminator.fsListFiles(sessionId).then(
      (r) => live && setList(r),
      () => live && setList({ files: [], truncated: false }),
    )
    return () => {
      live = false
    }
  }, [sessionId])

  const { text, line } = splitLine(query)

  const rows = useMemo((): Row[] => {
    if (!list) return []
    if (!text.trim()) {
      // Nothing typed yet: the files already open here, then the rest in listing order.
      const prefix = root.endsWith('/') ? root : `${root}/`
      const open = openPaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
      const seen = new Set(open)
      const rest = list.files.filter((f) => !seen.has(f)).slice(0, MAX_ROWS)
      return [...open, ...rest].slice(0, MAX_ROWS).map((rel) => ({ rel, positions: [] }))
    }
    const hits: { rel: string; score: number; positions: number[] }[] = []
    for (const rel of list.files) {
      const m = fuzzyMatch(text, rel)
      if (m) hits.push({ rel, score: m.score, positions: m.positions })
    }
    hits.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel))
    return hits.slice(0, MAX_ROWS)
  }, [list, text, openPaths, root])

  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const pick = (rel: string): void => {
    onClose(false)
    const path = joinPath(root, rel)
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    // A deliberate open, so a tab that stays — and it keeps the file if it was the preview.
    void editor.openFile(sessionId, path, name).then(() => {
      if (line) editor.revealLine(sessionId, path, line)
      else editor.focusTab(sessionId, path)
    })
  }

  const step = (by: number): void => {
    if (rows.length) setSel((i) => (i + by + rows.length) % rows.length)
  }

  let note: string | null = null
  if (!list) note = 'Listing files…'
  else if (!rows.length) note = list.files.length ? 'No matching files' : 'No files here'
  else if (list.truncated) note = `Searching the first ${list.files.length.toLocaleString()} files only`

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(560px, calc(100% - 24px))',
        zIndex: 5,
        display: 'flex',
        flexDirection: 'column',
        padding: 6,
        borderRadius: 9,
        border: `1px solid ${C.border3}`,
        background: C.panel,
        boxShadow: C.shadowMenu,
        animation: 'cc-fade 0.12s ease',
      }}
    >
      <input
        autoFocus
        value={query}
        spellCheck={false}
        placeholder="Search files by name — add :line to go to a line"
        onChange={(e) => {
          setQuery(e.target.value)
          setSel(0)
        }}
        onBlur={() => onClose(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            step(1)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            step(-1)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const r = rows[sel]
            if (r) pick(r.rel)
          } else if (e.key === 'Escape') {
            // Esc here closes the box, nothing more: without this, App.tsx's Escape chain
            // would carry on to whatever else it closes.
            e.preventDefault()
            e.stopPropagation()
            onClose(true)
          }
        }}
        style={{ ...inputStyle, padding: '7px 10px' }}
      />
      {rows.length > 0 && (
        <div ref={listRef} style={{ maxHeight: 360, overflowY: 'auto', marginTop: 6 }}>
          {rows.map((r, i) => {
            const base = r.rel.lastIndexOf('/') + 1
            const hits = new Set(r.positions)
            const on = i === sel
            return (
              <div
                key={r.rel}
                // Keep focus in the input, or its blur would close the box before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                // Move, not enter: the list scrolling under a still pointer isn't a choice.
                onMouseMove={() => setSel(i)}
                onClick={() => pick(r.rel)}
                title={r.rel}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 26,
                  padding: '0 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  background: on ? C.hover : 'transparent',
                  color: on ? C.textHi : C.body,
                }}
              >
                <span style={{ display: 'flex', flex: 'none', color: C.muted }}>
                  <Icon name="file" size={12} />
                </span>
                <span style={{ fontSize: 12, flex: 'none', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <Marked text={r.rel.slice(base)} from={base} hits={hits} />
                </span>
                {base > 0 && (
                  <span style={{ fontSize: 11, color: C.dim, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <Marked text={r.rel.slice(0, base - 1)} from={0} hits={hits} />
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
      {note && <div style={{ padding: '8px 8px 2px', fontSize: 11.5, color: C.dim }}>{note}</div>}
    </div>
  )
}
