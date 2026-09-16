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

import { app, session, shell, type Event, type Session, type WebContents } from 'electron'
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

  // No download UI here, and a file appearing somewhere unannounced is the wrong
  // surprise. Hand it to the OS browser, which has both the UI and the prompt.
  ses.on('will-download', (e, item) => {
    e.preventDefault()
    const url = webUrl(item.getURL())
    if (url) void shell.openExternal(url)
  })

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
