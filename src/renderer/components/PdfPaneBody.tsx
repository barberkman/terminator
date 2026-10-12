import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '../../shared/types'
import { parseWslUnc } from '../../shared/wsl-path'
import { useStore } from '../state/store'
import { useFindKeys } from '../find'
import { C, sz } from '../theme'
import { Icon } from '../icons'
import * as pdf from '../pdf/registry'
import { EMPTY_PDF_VIEW, usePdfStore, type PdfView } from '../pdf/pdfStore'
import { FindBar } from './FindBar'
import { ChromeButton } from './controls'

/**
 * A PDF, inside the app, in the app's theme.
 *
 * Rendering is pdf.js, and everything live — the viewer, the document, the file
 * watch — belongs to pdf/registry.ts rather than to this component. That is what lets
 * the pane be mounted and unmounted with its split like an editor pane: the viewer's
 * element is re-parented in here on mount and parked offscreen on unmount, so you
 * come back on the same page, at the same zoom, scrolled where you were, without the
 * file being read or a page drawn again. All this component owns is the chrome.
 */

/** pdf.js's scale values, as the zoom menu lists them. Numbers are spelled the way String() spells them. */
const SCALES: { value: string; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'page-fit', label: 'Page fit' },
  { value: 'page-width', label: 'Page width' },
  { value: '0.5', label: '50%' },
  { value: '0.75', label: '75%' },
  { value: '1', label: '100%' },
  { value: '1.25', label: '125%' },
  { value: '1.5', label: '150%' },
  { value: '2', label: '200%' },
  { value: '3', label: '300%' },
  { value: '4', label: '400%' },
]

function baseName(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p
}

const fieldStyle: React.CSSProperties = {
  padding: '4px 7px',
  background: C.input,
  // Longhand rather than `border`: a shorthand holding a var() is dropped, not
  // updated, when the theme changes underneath it (see FindBar).
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: C.border2,
  borderRadius: 7,
  color: C.textHi,
  font: 'inherit',
  fontSize: 11.5,
  outline: 'none',
}

const primaryBtn: React.CSSProperties = {
  padding: '7px 13px',
  background: C.accentBg,
  border: `1px solid ${C.accentBorder}`,
  borderRadius: 8,
  color: C.accentSoft,
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: 'transparent',
  border: `1px solid ${C.border2}`,
  color: C.muted,
}

export function PdfPaneBody({ session }: { session: Session }): React.JSX.Element {
  const id = session.id
  const path = session.file ?? ''
  const view = usePdfStore((s) => s.sessions[id]) ?? EMPTY_PDF_VIEW
  const focusedHere = useStore((s) => s.panes[s.focused] === id)
  const pushToast = useStore((s) => s.pushToast)
  const host = useRef<HTMLDivElement>(null)
  // The page a restored session reopens on. Read once: later saves are this pane's
  // own reading position coming back, and must not send it jumping.
  const firstPage = useRef(session.pdfPage)

  // Mount the session's viewer into this pane, and park it again when the split
  // goes — never dispose it: that is the session being removed (store.remove).
  useEffect(() => {
    if (!path) return
    pdf.open(id, path, firstPage.current)
    if (host.current) pdf.mount(id, host.current)
    return () => pdf.park(id)
  }, [id, path])

  const ready = view.status === 'ok'
  const outside = useCallback(() => {
    void window.terminator.openPdfOutside(id).then((r) => {
      if (!r.ok) pushToast({ tone: 'error', text: "Couldn't open the PDF", sub: r.reason })
    })
  }, [id, pushToast])

  // ---- find ----
  // One bar per window, as in the browser pane: opening it here closes any other.
  const findOpen = useStore((s) => s.findFor === id)
  const setFindFor = useStore((s) => s.setFindFor)
  const [findQuery, setFindQuery] = useState('')
  const findInput = useRef<HTMLInputElement | null>(null)

  const openFind = useCallback(() => {
    if (!ready) return
    setFindFor(id)
    requestAnimationFrame(() => {
      findInput.current?.focus()
      findInput.current?.select()
    })
  }, [ready, id, setFindFor])

  const closeFind = useCallback(() => {
    setFindFor(null)
    pdf.focus(id)
  }, [id, setFindFor])

  useFindKeys(focusedHere && ready, openFind)

  // However the bar went — Esc, another pane taking it, this pane unmounting — the
  // highlights go with it.
  useEffect(() => {
    if (findOpen) return
    setFindQuery('')
    pdf.closeFind(id)
  }, [findOpen, id])

  useEffect(() => {
    return () => {
      const st = useStore.getState()
      if (st.findFor === id) st.setFindFor(null)
    }
  }, [id])

  const name = baseName(path) || session.name
  const shownPath = parseWslUnc(path)?.linux ?? path

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: C.bg }}>
      <Toolbar
        id={id}
        view={view}
        ready={ready}
        onCopy={() => {
          window.terminator.clipboardWrite(shownPath)
          pushToast({ tone: 'ok', text: 'Copied path', sub: shownPath, icon: 'copy' })
        }}
        onOutside={outside}
      />

      {view.gone && ready && (
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
          <span style={{ flex: 1, minWidth: 0 }}>
            The file is gone or half-written — this is the last version that opened. It reloads
            when the file is back.
          </span>
        </div>
      )}

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {/* The viewer's element lands in here (pdf.mount). Always rendered, even
            under a state screen, so mounting never has to wait for one to clear. */}
        <div ref={host} style={{ position: 'absolute', inset: 0 }} />
        {!path ? (
          <Screen title="This PDF session has no file" danger />
        ) : (
          <StateScreen id={id} view={view} name={name} path={shownPath} onOutside={outside} />
        )}
        {findOpen && (
          <FindBar
            query={findQuery}
            onQuery={(q) => {
              setFindQuery(q)
              pdf.find(id, q, false, false)
            }}
            hits={view.findHits}
            onNext={() => pdf.find(id, findQuery, true, false)}
            onPrev={() => pdf.find(id, findQuery, true, true)}
            onClose={closeFind}
            inputRef={findInput}
          />
        )}
      </div>

      <div
        style={{
          flex: 'none',
          display: 'flex',
          gap: 10,
          padding: '5px 10px',
          borderTop: `1px solid ${C.border}`,
          color: C.dim,
          fontSize: 10.5,
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={shownPath}>
          {view.title || name}
        </span>
        {ready && (
          <span style={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
            {view.numPages} {view.numPages === 1 ? 'page' : 'pages'} · {Math.round(view.scale * 100)}%
          </span>
        )}
      </div>
    </div>
  )
}

function Toolbar({
  id,
  view,
  ready,
  onCopy,
  onOutside,
}: {
  id: string
  view: PdfView
  ready: boolean
  onCopy: () => void
  onOutside: () => void
}): React.JSX.Element {
  // What's typed in the page box, while it's being typed; otherwise it follows the
  // page you're on.
  const [draft, setDraft] = useState<string | null>(null)
  const scaleKnown = SCALES.some((s) => s.value === view.scaleValue)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '6px 8px',
        borderBottom: `1px solid ${C.border}`,
        background: C.panel,
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
      <ChromeButton icon="up" label="Previous page" disabled={!ready || view.page <= 1} onClick={() => pdf.step(id, -1)} />
      <ChromeButton
        icon="down"
        label="Next page"
        disabled={!ready || view.page >= view.numPages}
        onClick={() => pdf.step(id, 1)}
      />
      <input
        value={draft ?? (ready ? String(view.page) : '')}
        disabled={!ready}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onFocus={(e) => e.target.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = Number(draft)
            if (draft && Number.isFinite(n)) pdf.goTo(id, n)
            setDraft(null)
            pdf.focus(id)
          }
          // Esc here means "never mind", not "leave the pane" — App.tsx's Escape
          // chain would otherwise read it as closing something.
          if (e.key === 'Escape') {
            e.stopPropagation()
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
        aria-label="Page"
        inputMode="numeric"
        style={{ ...fieldStyle, width: sz(38), textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
      />
      <span style={{ color: C.dim, fontSize: 11.5, padding: '0 6px 0 2px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        / {ready ? view.numPages : '–'}
      </span>

      <div style={{ width: 1, height: 16, background: C.border2, margin: '0 4px', flex: 'none' }} />

      <ChromeButton icon="zoom-out" label="Zoom out" disabled={!ready} onClick={() => pdf.zoom(id, -1)} />
      <select
        value={scaleKnown ? view.scaleValue : 'custom'}
        disabled={!ready}
        onChange={(e) => {
          if (e.target.value !== 'custom') pdf.setScale(id, e.target.value)
          pdf.focus(id)
        }}
        aria-label="Zoom"
        style={{ ...fieldStyle, width: sz(104), cursor: ready ? 'pointer' : 'default' }}
      >
        {!scaleKnown && <option value="custom">{Math.round(view.scale * 100)}%</option>}
        {SCALES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <ChromeButton icon="zoom-in" label="Zoom in" disabled={!ready} onClick={() => pdf.zoom(id, 1)} />

      <div style={{ flex: 1, minWidth: 4 }} />

      <ChromeButton
        icon="contrast"
        label={view.recolor ? 'Themed pages — click for the original colours' : 'Original colours — click for themed pages'}
        pressed={view.recolor}
        onClick={() => pdf.setRecolor(id, !view.recolor)}
      />
      <ChromeButton icon="restart" label="Reload" onClick={() => pdf.reload(id)} />
      <ChromeButton icon="copy" label="Copy path" onClick={onCopy} />
      <ChromeButton icon="external" label="Open in your PDF viewer" onClick={onOutside} />
    </div>
  )
}

/** Everything that isn't a document on screen: opening, gone, too big, locked, broken. */
function StateScreen({
  id,
  view,
  name,
  path,
  onOutside,
}: {
  id: string
  view: PdfView
  name: string
  path: string
  onOutside: () => void
}): React.JSX.Element | null {
  switch (view.status) {
    case 'ok':
      return null
    case 'loading':
      return <Screen title={`Opening ${name}…`} />
    case 'missing':
      return (
        <Screen title="This PDF isn't there any more" sub={path} danger>
          <button style={primaryBtn} onClick={() => pdf.reload(id)}>
            Try again
          </button>
        </Screen>
      )
    case 'tooLarge':
      return (
        <Screen title="This PDF is too large to open here (over 256 MB)" sub={path}>
          <button style={primaryBtn} onClick={onOutside}>
            Open in your PDF viewer
          </button>
        </Screen>
      )
    case 'password':
      return <PasswordScreen id={id} name={name} wrong={!!view.wrongPassword} />
    case 'error':
      return (
        <Screen title={view.error || "This PDF couldn't be opened"} sub={path} danger>
          <button style={primaryBtn} onClick={() => pdf.reload(id)}>
            Try again
          </button>
          <button style={secondaryBtn} onClick={onOutside}>
            Open in your PDF viewer
          </button>
        </Screen>
      )
  }
}

function Screen({
  title,
  sub,
  danger,
  children,
}: {
  title: string
  sub?: string
  danger?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 24,
        textAlign: 'center',
        background: C.bg,
        color: C.dim,
      }}
    >
      <span style={{ opacity: 0.4 }}>
        <Icon name="pdf" size={26} />
      </span>
      <div style={{ color: danger ? C.danger : C.muted, fontSize: 13, fontWeight: danger ? 600 : 400 }}>{title}</div>
      {sub && <div style={{ fontSize: 11, overflowWrap: 'anywhere', maxWidth: 480 }}>{sub}</div>}
      {children && <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>{children}</div>}
    </div>
  )
}

function PasswordScreen({ id, name, wrong }: { id: string; name: string; wrong: boolean }): React.JSX.Element {
  const [pw, setPw] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    // A wrong password clears the box for the next try.
    if (wrong) setPw('')
  }, [wrong])
  const submit = (): void => {
    if (pw) pdf.submitPassword(id, pw)
  }
  return (
    <Screen title={`${name} is password-protected`} sub={wrong ? "That password didn't work — try again." : undefined} danger={wrong}>
      <input
        ref={input}
        type="password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') e.stopPropagation()
        }}
        placeholder="Password"
        aria-label="Password"
        style={{ ...fieldStyle, width: 200, padding: '7px 10px', fontSize: 12 }}
      />
      <button style={primaryBtn} onClick={submit}>
        Open
      </button>
    </Screen>
  )
}
