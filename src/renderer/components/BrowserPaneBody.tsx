import { useEffect, useRef, useState } from 'react'
import { BROWSER_PARTITION, UI_BASE_FONT_SIZE, type Session } from '../../shared/types'
import { webUrl } from '../../shared/url'
import type { WebviewTag } from '../global.d'
import { useStore } from '../state/store'
import { C, sz } from '../theme'
import { Icon, type IconName } from '../icons'
import { openOutsideApp } from '../term/links'

/**
 * A web page, inside the app.
 *
 * The guest is an Electron <webview>: a DOM element, so it sits in the pane grid
 * like anything else and the overlays above it — Settings, context menus, toasts,
 * the drop veil — keep working without anyone coordinating z-order. A
 * WebContentsView would paint over all of them.
 *
 * What the guest is *allowed* to be isn't decided here. The attributes below are a
 * request; main rewrites them in `will-attach-webview` and polices every
 * navigation afterwards (see main/browser.ts). This component only drives it.
 *
 * Two things about the tag shape the code more than they look:
 *
 *   • `src`, `partition` and `allowpopups` are read when the guest attaches and
 *     can't meaningfully change after. So `src` is captured once and every later
 *     navigation goes through `loadURL` — binding `src` to state would re-navigate
 *     on unrelated re-renders.
 *   • Every method throws until `dom-ready`. Hence the `ready` gate rather than
 *     calling `canGoBack()` on mount and wondering why the pane is blank.
 */

/** ERR_ABORTED — a navigation replaced by another one, not a failure to report. */
const ERR_ABORTED = -3

/** Events the guest fires at us, with the fields we read off them. */
type GuestEvent = Event & {
  url?: string
  title?: string
  isMainFrame?: boolean
  errorCode?: number
  errorDescription?: string
  validatedURL?: string
}

/** What the user typed, as a URL to try. A bare host is the common case. */
function typedUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  return webUrl(text) ?? webUrl(`https://${text}`)
}

/** The host, for the pane's one-line "where am I" when there's no title yet. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function ChromeButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: IconName
  label: string
  onClick: () => void
  disabled?: boolean
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
        width: sz(26),
        height: sz(26),
        flex: 'none',
        borderRadius: 7,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'transparent',
        background: 'transparent',
        color: disabled ? C.faint : C.textSubtle,
        cursor: disabled ? 'default' : 'pointer',
        outline: 'none',
      }}
    >
      <Icon name={icon} size={14} />
    </button>
  )
}

export function BrowserPaneBody({ session }: { session: Session }): React.JSX.Element {
  const ref = useRef<WebviewTag | null>(null)
  // The first URL this pane ever sees, and then never again: `src` is only honoured
  // when the guest attaches, and rebinding it would turn an unrelated re-render into
  // a navigation. Everything after the first goes through `loadURL`.
  const [src, setSrc] = useState(session.url ?? '')
  const zoom = useStore((s) => (s.settings?.fontSize ?? UI_BASE_FONT_SIZE) / UI_BASE_FONT_SIZE)
  const pushToast = useStore((s) => s.pushToast)

  const [ready, setReady] = useState(false)
  const [current, setCurrent] = useState(session.url ?? '')
  const [draft, setDraft] = useState(session.url ?? '')
  // A ref, not state: nothing renders from it, and the guest's own navigation
  // events read it — from inside listeners bound once, which a state value would
  // have gone stale in.
  const typing = useRef(false)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [failure, setFailure] = useState<{ text: string; url: string } | null>(null)

  const has = !!src

  // A pane can open before it has a page — restored without one, or opened empty —
  // so the guest mounts when the first URL arrives rather than only at mount. The
  // guard is what keeps `src` a one-time value.
  useEffect(() => {
    if (!src && session.url) setSrc(session.url)
  }, [src, session.url])

  // The guest's own events. Attached once: `ref.current` is stable for the life of
  // the pane, and re-attaching on every state change would leak listeners.
  useEffect(() => {
    const wv = ref.current
    if (!wv) return

    const refreshNav = () => {
      try {
        setNav({ back: wv.canGoBack(), forward: wv.canGoForward() })
      } catch {
        // Raced a teardown; the next event puts it right.
      }
    }

    const arrived = (url: string) => {
      setCurrent(url)
      setFailure(null)
      // Don't overwrite a URL the user is halfway through typing.
      if (!typing.current) setDraft(url)
      refreshNav()
      // Remember where we are, so a restart reopens here. Main re-validates it:
      // this URL came from a page, and a page picks its own navigations.
      void window.terminator.setSessionUrl(session.id, url)
    }

    const onReady = () => {
      setReady(true)
      refreshNav()
    }
    const onStart = () => {
      setLoading(true)
      setFailure(null)
    }
    const onStop = () => {
      setLoading(false)
      refreshNav()
    }
    const onNavigate = (e: GuestEvent) => {
      if (e.url) arrived(e.url)
    }
    const onInPage = (e: GuestEvent) => {
      if (e.url && e.isMainFrame !== false) arrived(e.url)
    }
    const onTitle = (e: GuestEvent) => setTitle(e.title ?? '')
    const onFail = (e: GuestEvent) => {
      // A dead image is not a dead page, and ERR_ABORTED is the navigation you
      // just replaced — reporting either as a failure is the classic false error.
      if (e.isMainFrame === false || e.errorCode === ERR_ABORTED) return
      setLoading(false)
      setFailure({
        text: e.errorDescription || 'the page could not be loaded',
        url: e.validatedURL || current,
      })
    }

    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', onNavigate as EventListener)
    wv.addEventListener('did-navigate-in-page', onInPage as EventListener)
    wv.addEventListener('page-title-updated', onTitle as EventListener)
    wv.addEventListener('did-fail-load', onFail as EventListener)
    return () => {
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', onNavigate as EventListener)
      wv.removeEventListener('did-navigate-in-page', onInPage as EventListener)
      wv.removeEventListener('page-title-updated', onTitle as EventListener)
      wv.removeEventListener('did-fail-load', onFail as EventListener)
    }
    // `current` is only read inside onFail's fallback; re-binding for it would
    // churn every listener on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, has])

  // Someone opened another link into this pane. The session's URL is the
  // instruction; `getURL()` rather than state is the truth about where we are.
  useEffect(() => {
    const wv = ref.current
    const wanted = session.url
    if (!wv || !ready || !wanted) return
    let at = ''
    try {
      at = wv.getURL()
    } catch {
      return
    }
    if (at !== wanted) void wv.loadURL(wanted)
  }, [session.url, ready])

  // The global UI zoom scales the host frame only — a guest is its own frame tree
  // and would stay at 100%, leaving the chrome large and the page small.
  useEffect(() => {
    const wv = ref.current
    if (!wv || !ready) return
    try {
      wv.setZoomFactor(zoom)
    } catch {
      // Guest went away mid-resize; nothing to do.
    }
  }, [zoom, ready])

  const go = (text: string) => {
    const url = typedUrl(text)
    if (!url) {
      pushToast({
        tone: 'error',
        text: "Couldn't open that",
        sub: 'only http and https addresses can be opened here',
      })
      return
    }
    typing.current = false
    // With no guest yet, the session's URL is how it gets one: the effect above
    // mounts the tag, and `src` carries it.
    if (ready && ref.current) void ref.current.loadURL(url)
    else void window.terminator.setSessionUrl(session.id, url)
  }

  const act = (fn: (wv: WebviewTag) => void) => () => {
    const wv = ref.current
    if (!wv || !ready) return
    try {
      fn(wv)
    } catch {
      // Guest not attached yet, or torn down. Nothing useful to say.
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: C.bg }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '6px 8px',
          borderBottom: `1px solid ${C.border}`,
          background: C.panel,
        }}
      >
        <ChromeButton icon="back" label="Back" disabled={!nav.back} onClick={act((w) => w.goBack())} />
        <ChromeButton
          icon="forward"
          label="Forward"
          disabled={!nav.forward}
          onClick={act((w) => w.goForward())}
        />
        <ChromeButton
          icon={loading ? 'close' : 'restart'}
          label={loading ? 'Stop' : 'Reload'}
          disabled={!has}
          onClick={act((w) => (loading ? w.stop() : w.reload()))}
        />

        <input
          value={draft}
          onChange={(e) => {
            typing.current = true
            setDraft(e.target.value)
          }}
          onFocus={(e) => e.target.select()}
          onBlur={() => {
            typing.current = false
            // Only fall back to a page there actually is. A pane opened from the
            // menu has none, and wiping the address on the way to clicking
            // something else would throw away the only thing you'd typed.
            if (current) setDraft(current)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(draft)
            // Esc in the address bar means "never mind", not "leave the pane" —
            // stop it before App.tsx's chain reads it as closing something.
            if (e.key === 'Escape') {
              e.stopPropagation()
              typing.current = false
              setDraft(current)
              e.currentTarget.blur()
            }
          }}
          spellCheck={false}
          placeholder="Type an address"
          style={{
            flex: 1,
            minWidth: 0,
            padding: '5px 9px',
            background: C.input,
            border: `1px solid ${C.border2}`,
            borderRadius: 7,
            color: C.textHi,
            font: 'inherit',
            fontSize: 11.5,
            outline: 'none',
          }}
        />

        <ChromeButton
          icon="copy"
          label="Copy link"
          disabled={!current}
          onClick={() => {
            window.terminator.clipboardWrite(current)
            pushToast({ tone: 'ok', text: 'Copied link', sub: current, icon: 'copy' })
          }}
        />
        <ChromeButton
          icon="external"
          label="Open in your browser"
          disabled={!current}
          onClick={() => void openOutsideApp(current)}
        />
      </div>

      {/* A page is slow often enough that a pane with no sign of life reads as
          broken. Two pixels of accent is the whole affordance. */}
      <div style={{ height: 2, flex: 'none', background: loading ? C.accent : 'transparent' }} />

      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
        {has ? (
          <webview
            ref={ref}
            src={src}
            partition={BROWSER_PARTITION}
            // Claude's Google sign-in is a popup. Without this, window.open returns
            // null and the button appears to do nothing; main pins the popup to the
            // same partition so the cookie it sets is the one this pane reads.
            allowpopups={true}
            style={{ flex: 1, minWidth: 0, background: C.bg }}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              color: C.dim,
            }}
          >
            <span style={{ opacity: 0.4 }}>
              <Icon name="globe" size={26} />
            </span>
            <div style={{ fontSize: 12 }}>Nothing open — type an address above</div>
          </div>
        )}

        {failure && (
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
            }}
          >
            <div style={{ color: C.danger, fontSize: 13, fontWeight: 600 }}>{failure.text}</div>
            <div style={{ color: C.dim, fontSize: 11, overflowWrap: 'anywhere', maxWidth: 480 }}>
              {failure.url}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                onClick={act((w) => w.reload())}
                style={{
                  padding: '7px 13px',
                  background: C.accentBg,
                  border: `1px solid ${C.accentBorder}`,
                  borderRadius: 8,
                  color: C.accentSoft,
                  font: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <button
                onClick={() => void openOutsideApp(failure.url)}
                style={{
                  padding: '7px 13px',
                  background: 'transparent',
                  border: `1px solid ${C.border2}`,
                  borderRadius: 8,
                  color: C.muted,
                  font: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Open in your browser
              </button>
            </div>
          </div>
        )}
      </div>

      {/* The page's own title, below rather than in the pane header: the header
          names the session, and a page that renames the session every navigation
          would make the sidebar unreadable. */}
      {has && (
        <div
          style={{
            flex: 'none',
            padding: '5px 10px',
            borderTop: `1px solid ${C.border}`,
            color: C.dim,
            fontSize: 10.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {loading ? 'Loading…' : title || hostOf(current)}
        </div>
      )}
    </div>
  )
}
