import { useCallback, useEffect, useRef, useState } from 'react'
import { BROWSER_PARTITION, UI_BASE_FONT_SIZE, type Session } from '../../shared/types'
import { webUrl } from '../../shared/url'
import type { FoundInPageResult, WebviewTag } from '../global.d'
import { modalOpen, useStore } from '../state/store'
import { NO_HITS, useFindKeys, type FindHits } from '../find'
import { C, sz } from '../theme'
import { Icon, type IconName } from '../icons'
import { openOutsideApp } from '../term/links'
import { FindBar } from './FindBar'

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
  result?: FoundInPageResult
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
  const focusedHere = useStore((s) => s.panes[s.focused] === session.id)

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

  // The find bar. Whether it's open lives in the store rather than here, because
  // that is the behaviour: a window has one find bar, so opening one anywhere
  // closes the one you left behind.
  const findOpen = useStore((s) => s.findFor === session.id)
  const setFindFor = useStore((s) => s.setFindFor)
  const [findQuery, setFindQuery] = useState('')
  const [findHits, setFindHits] = useState<FindHits>(NO_HITS)
  const findInput = useRef<HTMLInputElement | null>(null)
  // The id of the request whose answer we're still waiting for. Two keystrokes in
  // quick succession are two searches in flight, and without this the slower one
  // lands last and leaves a counter describing the query before the one you typed.
  const findReq = useRef(0)
  // The text the guest's current find session was opened on. Asking Chromium to
  // continue a session against text it never saw is meaningless, and a stale bar
  // can ask: a navigation tears the session down underneath one.
  const lastQuery = useRef('')
  // This pane's guest, so it can tell a key main forwarded *to it* from one meant
  // for the other browser pane.
  const guestId = useRef(0)

  const has = !!src

  /**
   * Ask the guest to find. Chromium does the searching, the tinting and the
   * counting — there is no other way into a page that is its own frame tree, and
   * the highlight it paints is not ours to theme. The counter that comes back is
   * the one every browser shows, which is the upside of the same bargain.
   *
   * `fresh` opens a new find session — what a new or edited query wants; stepping
   * continues the one already open. Electron spells the latter `findNext`, and its
   * own docs get this backwards ("should be `true` for initial requests") one line
   * above stating the default is `false` — which is what `findInPage(text)` with no
   * options, the canonical first search, therefore passes. The default is the truth:
   * `false` begins a session, `true` advances within it. Inverting these two makes
   * every press of Next restart the search, which reads as a counter that will not
   * climb past the second match.
   */
  const runFind = useCallback((text: string, fresh: boolean, forward = true) => {
    const wv = ref.current
    if (!wv) return
    if (!text) {
      try {
        wv.stopFindInPage('clearSelection')
      } catch {
        // Guest torn down; nothing to clear.
      }
      lastQuery.current = ''
      findReq.current = 0
      setFindHits(NO_HITS)
      return
    }
    // Only a step against the text the session actually holds may continue it.
    const carryOn = !fresh && text === lastQuery.current
    try {
      findReq.current = wv.findInPage(text, { findNext: carryOn, forward })
      lastQuery.current = text
    } catch {
      // Guest not attached yet, or torn down between the keystroke and here.
    }
    // Deliberately not gated on `ready`: the guest throws until it is attached and
    // the catches above are the answer, which keeps this callback stable — the
    // navigation listener below is bound once and would otherwise close over a
    // version of it from before the page existed.
  }, [])

  const openFind = useCallback(() => {
    // Nothing to search in a pane that has never been given a page.
    if (!has) return
    setFindFor(session.id)
    // After the bar has rendered. Focusing an input that doesn't exist yet is the
    // quiet way for a shortcut to look like it did nothing.
    requestAnimationFrame(() => {
      findInput.current?.focus()
      findInput.current?.select()
    })
  }, [has, session.id, setFindFor])

  const closeFind = useCallback(() => {
    setFindFor(null)
    setFindQuery('')
    setFindHits(NO_HITS)
    runFind('', true)
    // Hand the keyboard back to the page, or the next keystroke goes nowhere.
    try {
      ref.current?.focus()
    } catch {
      // Guest went away; the pane is going with it.
    }
  }, [runFind, setFindFor])

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
      try {
        // Only valid once attached, which is what dom-ready means here.
        guestId.current = wv.getWebContentsId()
      } catch {
        // Raced a teardown; a pane with no guest has no find bar to open either.
      }
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
      // A new page throws the find results away, and a counter describing the
      // previous page is worse than no counter. In-page navigation — an anchor
      // click — deliberately doesn't do this: the results are still good.
      if (useStore.getState().findFor === session.id) closeFind()
    }
    const onInPage = (e: GuestEvent) => {
      if (e.url && e.isMainFrame !== false) arrived(e.url)
    }
    const onTitle = (e: GuestEvent) => setTitle(e.title ?? '')
    const onFound = (e: GuestEvent) => {
      const r = e.result
      // Anything but the request we're waiting on is a straggler from a query
      // that has already been typed over.
      if (!r || r.requestId !== findReq.current) return
      // One request reports several times as Chromium scopes a long page, and an
      // early report can carry a count with no active match yet. Drawing that as
      // 0/17 is a frame of "found nothing" at the moment something was found, so
      // the ordinal holds its last real value and only a genuine zero clears it.
      setFindHits((prev) => ({
        index: r.matches ? r.activeMatchOrdinal || prev.index : 0,
        total: r.matches,
      }))
    }
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
    wv.addEventListener('found-in-page', onFound as EventListener)
    wv.addEventListener('did-fail-load', onFail as EventListener)
    return () => {
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', onNavigate as EventListener)
      wv.removeEventListener('did-navigate-in-page', onInPage as EventListener)
      wv.removeEventListener('page-title-updated', onTitle as EventListener)
      wv.removeEventListener('found-in-page', onFound as EventListener)
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

  // The other half of F5. main/browser.ts catches it when the page has focus —
  // the key never reaches this renderer then — and this catches it when the pane's
  // own chrome has it: the address bar, or a pane you have only just opened and
  // not yet clicked into.
  //
  // Bound only while this pane is the focused one, so F5 still reaches a program
  // running in a terminal, and two open browser panes can't both answer one press.
  useEffect(() => {
    if (!focusedHere) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F5') return
      // Don't act underneath a modal.
      if (modalOpen()) return
      const wv = ref.current
      if (!wv || !ready) return
      e.preventDefault()
      try {
        wv.reload()
      } catch {
        // Guest torn down between the press and here.
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedHere, ready])

  // Ctrl/Cmd+F splits the same two ways F5 does, for the same reason. This is the
  // chrome-focused half; the in-page half is the effect below.
  useFindKeys(focusedHere, openFind)

  // …and the half that came out of the page. main can't open the bar itself — the
  // bar is here — so it reports the press with the guest's id and every pane
  // checks whether that guest is its own. Bound regardless of focus: pressing a
  // key *in* a page is as clear a statement of which pane you mean as there is,
  // and the store's focus may not have caught up if you clicked straight into it.
  useEffect(() => {
    return window.terminator.onBrowserFind((id) => {
      if (!guestId.current || id !== guestId.current) return
      openFind()
    })
  }, [openFind])

  // A bar left open when the pane goes away — closed, or given to another session
  // — shouldn't be sitting there waiting if it comes back. Guarded, because by
  // then the one open bar may belong to another pane.
  useEffect(() => {
    return () => {
      const st = useStore.getState()
      if (st.findFor === session.id) st.setFindFor(null)
    }
  }, [session.id])

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
          label={loading ? 'Stop' : 'Reload (F5)'}
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

        {/* Last in the wrapper, so it floats above the failure overlay too. */}
        {findOpen && (
          <FindBar
            query={findQuery}
            onQuery={(q) => {
              setFindQuery(q)
              // Every keystroke restarts the search, which is what a browser does
              // and what Chromium is built to absorb.
              runFind(q, true)
            }}
            hits={findHits}
            onNext={() => runFind(findQuery, false, true)}
            onPrev={() => runFind(findQuery, false, false)}
            onClose={closeFind}
            inputRef={findInput}
          />
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
