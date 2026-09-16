import type { TerminatorApi } from '../shared/types'

/**
 * The guest methods a browser pane calls.
 *
 * Electron ships a `WebviewTag` type, but `tsconfig.web.json` gives the renderer
 * `"types": ["node"]` only — Electron's types aren't in scope here, and pulling
 * them in for one element would put main-process APIs within reach of renderer
 * code that has no business touching them. So this declares exactly what
 * BrowserPaneBody uses and nothing else.
 *
 * Every method below throws until the guest is attached and `dom-ready` has
 * fired, which is why the component gates on it rather than calling on mount.
 */
export interface WebviewTag extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  reload(): void
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  setZoomFactor(factor: number): void
  /** Returns a request id; the answer arrives later on `found-in-page`. */
  findInPage(text: string, options?: FindInPageOptions): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  /** This guest's webContents id — how a pane recognises a key main forwarded to it. */
  getWebContentsId(): number
}

export interface FindInPageOptions {
  forward?: boolean
  /**
   * Electron's naming is the wrong way round from what it reads like: `true`
   * *begins* a new find session and `false` continues the last one. So a new or
   * edited query passes true, and stepping passes false.
   */
  findNext?: boolean
  matchCase?: boolean
}

/** What the guest hands back on `found-in-page`. */
export interface FoundInPageResult {
  requestId: number
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

declare global {
  interface Window {
    terminator: TerminatorApi
  }
}

/**
 * React's own JSX already knows `<webview>` and its attributes — `src`,
 * `partition`, `allowpopups` and the rest are in `WebViewHTMLAttributes`. What it
 * doesn't know is that the element has methods: its `HTMLWebViewElement` is a bare
 * `HTMLElement`. This augmentation exists solely to type the ref, so `goBack()`
 * and friends are checked rather than reached for through a cast.
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<WebviewTag>, WebviewTag>
    }
  }
}
