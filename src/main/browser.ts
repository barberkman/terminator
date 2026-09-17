// The in-app browser's session, and the guards around anything it renders.
//
// Handing a URL to Chrome and rendering it inside the app are not the same
// promise. `links.ts` can afford to say "this is someone else's program now";
// here the page runs in our window, so the same doctrine has to be enforced
// rather than delegated:
//
//   • Its own persistent partition. Cookies, localStorage and the rest live in
//     userData/Partitions/browser — separate from the app's session, so a page
//     can't reach app storage, and persistent, so a Claude login survives a
//     restart. Staying signed in is the whole reason this exists.
//   • Every navigation re-checked through `webUrl`, the same gate a clicked link
//     already passes. The renderer sets the <webview> attributes; main decides
//     what they're allowed to mean.
//   • Popups are allowed but pinned to the same partition. Claude's Google
//     sign-in is a popup, and a cookie that lands in a different jar is no login
//     at all.
//   • No permissions, and no silent downloads.
//
// Scoping is by session identity, not window: anything running on the browser
// partition is guarded, and the app's own window — which is on the default
// session — is never touched by any of it.

import {
  app,
  session,
  type Event,
  type Session,
  type WebContents,
  type WebPreferences,
} from 'electron'
import { Channels } from '../shared/channels'
import { BROWSER_PARTITION, type BrowserClearWhat } from '../shared/types'
import { webUrl } from './links'
import { loadSettings } from './settings'

/** The one Electron session every in-app browser pane and its popups run on. */
export function browserSession(): Session {
  return session.fromPartition(BROWSER_PARTITION)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * What the in-app browser calls itself.
 *
 * Electron's own UA carries `Terminator/0.1.0` and `Electron/42.5.0`, and those
 * two tokens are exactly how Google decides it's looking at an embedded browser
 * and refuses to run an OAuth flow in it. Stripping them leaves the Chrome UA
 * underneath, which is the truth that matters to a server: this *is* Chromium.
 * The setting overrides it outright for the site that still says no.
 */
export function browserUserAgent(): string {
  const configured = loadSettings().browser?.userAgent?.trim()
  if (configured) return configured
  return app.userAgentFallback
    .replace(new RegExp(`\\s*${escapeRe(app.getName())}/\\S+`, 'i'), '')
    .replace(/\s*Electron\/\S+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Push the current user agent onto the partition. Safe to call again after a save. */
export function applyBrowserUserAgent(): void {
  browserSession().setUserAgent(browserUserAgent())
}

/**
 * Main's last word on what a <webview> is allowed to be, applied before the guest
 * attaches. Everything the renderer asked for is discarded rather than checked: a
 * preload is the only route a guest has to Node, so there must not be one, and the
 * partition is ours or it doesn't attach.
 *
 * The user agent belongs here and not only on the session. A guest's UA is fixed
 * from the tag when it attaches, so a session-level default never reaches its first
 * request — and the first request is the one that decides whether a sign-in is
 * allowed to start. Setting it later, on the contents, is already too late.
 *
 * The partition is the one thing here that is checked rather than corrected. By the
 * time this fires the guest's session has already been chosen, so writing
 * `params.partition` doesn't move it — a guest that asked for nothing quietly keeps
 * the app's own session, which is the opposite of what this file is for. So a guest
 * that didn't ask for ours doesn't attach at all.
 *
 * Returns false when the guest should be refused outright.
 */
export function applyWebviewPolicy(prefs: WebPreferences, params: Record<string, string>): boolean {
  delete prefs.preload
  prefs.nodeIntegration = false
  prefs.nodeIntegrationInSubFrames = false
  prefs.contextIsolation = true
  prefs.sandbox = true
  prefs.webSecurity = true
  prefs.allowRunningInsecureContent = false
  if (params.partition !== BROWSER_PARTITION) return false
  params.useragent = browserUserAgent()
  // about:blank is allowed because a pane attaches before it has a page; every
  // navigation after that is policed by `guard` below.
  const src = params.src ?? ''
  return !src || src === 'about:blank' || !!webUrl(src)
}

/**
 * One-time setup for the browser partition, plus the guards. Called at startup
 * rather than when the first pane opens, so a page can never render ahead of the
 * rules that constrain it.
 */
export function configureBrowserSession(): void {
  const ses = browserSession()
  applyBrowserUserAgent()

  // Nothing a page needs to show a diagram is behind a permission prompt, and a
  // prompt raised by a page the user didn't choose to visit is worse than a
  // feature that quietly doesn't work. One line to loosen if that ever bites.
  ses.setPermissionRequestHandler((_c, _permission, done) => done(false))

  // Downloads are deliberately left to Electron's default, which is to ask where
  // to save. There is no download UI here, so the OS dialog is the whole of the
  // consent — and it is the only option that also works for the blob: URL a page
  // uses to hand you something it built itself, which is exactly how a diagram
  // offers to save as SVG. Refusing outright would make that a dead end; refusing
  // *quietly*, which is what refusing a blob: by URL check amounts to, would be worse.

  app.on('web-contents-created', (_e, contents) => {
    // Session identity is the test: it catches every <webview> and every popup
    // they open, and can never catch the app's own window.
    if (contents.session !== ses) return
    guard(contents)
  })
}

/** Popups can arrive by two routes; neither should double up the listeners. */
const guarded = new WeakSet<WebContents>()

function guard(contents: WebContents): void {
  if (guarded.has(contents)) return
  guarded.add(contents)

  // A link click and a meta refresh land on will-navigate; a 30x into a custom
  // scheme lands only on will-redirect, which is the more interesting way out.
  // Both ask `webUrl`, so this agrees with `openLink` by construction.
  const gate = (e: Event, url: string) => {
    if (!webUrl(url)) e.preventDefault()
  }
  contents.on('will-navigate', gate)
  contents.on('will-redirect', gate)
  // Guests don't nest. A page embedding its own <webview> has no legitimate reason
  // to here, and it would arrive with prefs main never saw.
  contents.on('will-attach-webview', (e) => e.preventDefault())
  contents.setUserAgent(browserUserAgent())

  // F5 reloads the page, and Ctrl/Cmd+F opens the pane's find bar. Both have to
  // be caught here, on the guest, because that is where the key goes: a guest is
  // its own frame tree, so while the page has focus the renderer never sees a
  // keydown at all and a listener there would look broken exactly when you'd
  // reach for it. BrowserPaneBody catches the other half of each — the key
  // pressed with the pane's own chrome focused, which main never sees.
  //
  // F5 rather than Ctrl+R because Electron's default menu already owns Ctrl+R and
  // reloads the whole app window with it.
  contents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F5') {
      e.preventDefault()
      contents.reload()
      return
    }
    // `code`, not `key`, so a non-US layout still finds the F — the same
    // layout-independence the renderer's own shortcut matching is built on.
    if (input.code !== 'KeyF' || input.alt || input.shift || !(input.control || input.meta)) return
    // Unlike F5, this can't be finished here: the find bar is a React component
    // in the host window, so all main can do is report the press. It reports the
    // *guest's* id rather than working out which pane that is — main has no
    // notion of panes or sessions, and the pane that owns this guest can
    // recognise its own id perfectly well.
    //
    // A popup — which is what a Google sign-in is — is on this partition too but
    // has no host and no find bar, so the key simply does nothing there.
    const host = contents.hostWebContents
    if (!host || host.isDestroyed()) return
    // Taking the key away from a page that wanted it for its own find is what a
    // real browser does with Ctrl+F too, and is the price of having one here.
    e.preventDefault()
    host.send(Channels.browserFind, contents.id)
  })
  // A popup's contents is type 'window', not 'webview'. It is on our partition, so
  // the session test above catches it — but only if the session is assigned by the
  // time that event fires, and this doesn't depend on that.
  contents.on('did-create-window', (win) => guard(win.webContents))

  contents.setWindowOpenHandler(({ url }) => {
    if (!webUrl(url)) return { action: 'deny' }
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        width: 520,
        height: 720,
        autoHideMenuBar: true,
        webPreferences: {
          // The same jar, or the sign-in it just completed buys nothing.
          partition: BROWSER_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      },
    }
  })
}

/** Bytes held by the in-app browser's HTTP cache — the section summary's number. */
export function browserCacheSize(): Promise<number> {
  return browserSession().getCacheSize()
}

/**
 * Drop stored data. The three are kept apart because they cost different things:
 * `cache` is free, `cookies` signs you out of Claude, and `all` does both plus
 * the site storage a page kept for itself.
 */
export async function clearBrowserData(what: BrowserClearWhat): Promise<void> {
  const ses = browserSession()
  if (what === 'cache') {
    await ses.clearCache()
    return
  }
  if (what === 'cookies') {
    await ses.clearStorageData({ storages: ['cookies'] })
    await ses.clearAuthCache()
    return
  }
  await ses.clearStorageData()
  await ses.clearAuthCache()
  await ses.clearCache()
}
