import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import type { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { FsChange } from '../../shared/types'
import type { ThemePalette } from '../../shared/themes'
import { clickOpens, openWeb } from '../term/links'
import { ASSET_URLS, loadPdfjs, type Pdfjs } from './load'
import { NO_HITS } from '../find'
import { pdfView, usePdfStore, type PdfView } from './pdfStore'
import { ensureRecolorFilter, setRecolorTheme } from './recolor'

// The PDF engine: one live pdf.js viewer per PDF session, kept in this module and
// never in React state — the editor's design (editor/registry.ts), for the same
// reason. A pane is mounted and unmounted with its split; the viewer is not. Its
// element is parked offscreen while no split shows it and re-parented into the pane
// that does, so switching sessions, splitting or closing panes around it never
// re-reads the file, re-renders a page or loses your place.
//
// The document is read through the session's root-scoped file service
// (`fsReadBytes`), whose root for a PDF session is that one document — wherever it
// is — and is watched the same way an Editor pane's files are: a file rewritten
// underneath it — LaTeX, a build, Claude — reloads in place, on the page you were
// reading.

interface Entry {
  sessionId: string
  /** The document's absolute path, as the file service reads it. */
  path: string
  /** The scroll container pdf.js drives. Absolutely positioned, as PDFViewer demands. */
  el: HTMLDivElement
  pdf?: Pdfjs
  bus?: EventBus
  links?: PDFLinkService
  finder?: PDFFindController
  viewer?: PDFViewer
  doc?: PDFDocumentProxy
  task?: PDFDocumentLoadingTask
  /** Bumped by every load, so a slow one finishing late can tell it was overtaken. */
  seq: number
  watching: boolean
  /**
   * Where the reader is, kept up to date while the viewer is in a pane and restored
   * on the next mount. Recorded as it happens rather than read at park time: by the
   * time a pane's cleanup runs, React has already taken its element out of the
   * document, and a detached element reports a scroll offset of 0.
   */
  scroll: { top: number; left: number }
  /** In a pane right now (not parked, not mid-move) — when scroll events are the reader's. */
  shown: boolean
  resize: ResizeObserver
  reloadTimer?: number
  saveTimer?: number
  /** Hands a typed password back to pdf.js, while a load is waiting on one. */
  password?: (pw: string) => void
  /** Where the next document lands once its pages are laid out. */
  landing?: Landing
  /** The last find asked for, so a reload can bring its highlights back. */
  query: string
}

/** A position in the document, kept across a reload by page rather than by pixel. */
interface Landing {
  page: number
  /** How far into that page the top of the view was, in px at `scale`. */
  offset: number
  scaleValue: string
}

const entries = new Map<string, Entry>()
let holder: HTMLDivElement | null = null
let wired = false

/** How long a burst of writes gets to settle before the file is read again. */
const RELOAD_MS = 250
/** How long the page number waits before it is saved (scrolling fires it constantly). */
const SAVE_PAGE_MS = 800

const PRESETS = new Set(['auto', 'page-fit', 'page-width', 'page-actual'])

function ensureHolder(): HTMLDivElement {
  if (!holder) {
    holder = document.createElement('div')
    holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:900px;height:600px;overflow:hidden;'
    document.body.appendChild(holder)
  }
  return holder
}

/**
 * Subscribe once, the first time a PDF opens: to on-disk changes, and to sessions
 * going away — a removed session's viewer, document and file watch go with it.
 * Heard from main directly rather than from the store's `remove`, which is where
 * the editor is told: the store sits below the link code this module opens PDF
 * links through, and reaching back up into here would close the loop.
 */
function wire(): void {
  if (wired) return
  wired = true
  window.terminator.onFsChanged((c) => handleFsChange(c))
  window.terminator.onSessionRemoved((id) => dispose(id))
}

const patch = (id: string, p: Partial<PdfView>): void => usePdfStore.getState().patch(id, p)

// ---- session lifecycle -----------------------------------------------------

/**
 * Make sure a session has a viewer on `path`, loading it the first time. Idempotent:
 * every mount calls it, and only the first does anything.
 */
export function open(sessionId: string, path: string, page?: number): void {
  const cur = entries.get(sessionId)
  if (cur?.path === path) return
  if (cur) dispose(sessionId)
  wire()
  ensureRecolorFilter()

  const el = document.createElement('div')
  el.className = 'tm-pdf'
  // Focusable, so PageUp/PageDown/Home/End scroll it once it has been clicked.
  el.tabIndex = -1
  el.style.cssText = 'position:absolute;inset:0;overflow:auto;'
  const viewerEl = document.createElement('div')
  viewerEl.className = 'pdfViewer'
  el.appendChild(viewerEl)
  ensureHolder().appendChild(el)

  const e: Entry = {
    sessionId,
    path,
    el,
    seq: 0,
    watching: false,
    scroll: { top: 0, left: 0 },
    shown: false,
    resize: new ResizeObserver(() => refit(e)),
    landing: page && page > 1 ? { page, offset: 0, scaleValue: 'auto' } : undefined,
    query: '',
  }
  entries.set(sessionId, e)
  const view = pdfView(sessionId)
  el.classList.toggle('tm-pdf-recolor', view.recolor)
  el.addEventListener('click', (ev) => onClick(e, ev), true)
  el.addEventListener(
    'scroll',
    () => {
      if (e.shown) e.scroll = { top: el.scrollTop, left: el.scrollLeft }
    },
    { passive: true },
  )
  el.addEventListener('wheel', (ev) => onWheel(e, ev), { passive: false })
  patch(sessionId, { status: 'loading' })
  void load(e)
}

/** Tear a session's viewer down for good — the session itself was removed. */
function dispose(sessionId: string): void {
  const e = entries.get(sessionId)
  if (!e) return
  entries.delete(sessionId)
  e.seq++
  e.resize.disconnect()
  window.clearTimeout(e.reloadTimer)
  window.clearTimeout(e.saveTimer)
  if (e.watching) window.terminator.fsUnwatch(sessionId, e.path)
  try {
    e.viewer?.setDocument(null as unknown as PDFDocumentProxy)
  } catch {
    // A viewer that never got a document has nothing to let go of.
  }
  void e.task?.destroy()
  if (e.doc) void destroyDoc(e.doc)
  e.el.remove()
  usePdfStore.getState().clear(sessionId)
}

// ---- loading ---------------------------------------------------------------

/** pdf.js and this entry's viewer, made the first time either is needed. */
async function ensureViewer(e: Entry): Promise<boolean> {
  if (e.viewer) return true
  const pdf = await loadPdfjs()
  if (entries.get(e.sessionId) !== e) return false
  if (e.viewer) return true
  const { EventBus, PDFLinkService, PDFFindController, PDFViewer } = pdf.viewer
  const bus = new EventBus()
  const links = new PDFLinkService({ eventBus: bus })
  const finder = new PDFFindController({ eventBus: bus, linkService: links })
  const viewer = new PDFViewer({
    container: e.el,
    eventBus: bus,
    linkService: links,
    findController: finder,
    removePageBorders: true,
    // Form fields drawn on the canvas, where the theme reaches them, rather than as
    // live HTML inputs in the browser's own colours. This is a reader.
    annotationMode: pdf.lib.AnnotationMode.ENABLE,
    annotationEditorMode: pdf.lib.AnnotationEditorType.DISABLE,
  })
  links.setViewer(viewer)
  e.pdf = pdf
  e.bus = bus
  e.links = links
  e.finder = finder
  e.viewer = viewer

  bus.on('pagesinit', () => land(e))
  bus.on('pagechanging', (ev: { pageNumber: number }) => {
    patch(e.sessionId, { page: ev.pageNumber })
    window.clearTimeout(e.saveTimer)
    e.saveTimer = window.setTimeout(() => {
      void window.terminator.setSessionPdfPage(e.sessionId, ev.pageNumber)
    }, SAVE_PAGE_MS)
  })
  bus.on('scalechanging', (ev: { scale: number; presetValue?: string }) => {
    patch(e.sessionId, { scale: ev.scale, scaleValue: ev.presetValue || String(ev.scale) })
  })
  const onCount = (ev: { matchesCount?: { current: number; total: number } }): void => {
    const m = ev.matchesCount
    if (m) patch(e.sessionId, { findHits: { index: m.current, total: m.total } })
  }
  bus.on('updatefindmatchescount', onCount)
  bus.on('updatefindcontrolstate', onCount)
  return true
}

async function load(e: Entry): Promise<void> {
  const seq = ++e.seq
  const stale = (): boolean => e.seq !== seq || entries.get(e.sessionId) !== e
  const res = await window.terminator.fsReadBytes(e.sessionId, e.path)
  if (stale()) return
  if (!res.ok) {
    // Already showing something: keep it on screen and say the file is gone, rather
    // than blanking the pane over what may be a rebuild halfway through.
    if (e.doc) patch(e.sessionId, { gone: true })
    else patch(e.sessionId, { status: res.reason })
    watch(e)
    return
  }
  if (!(await ensureViewer(e)) || stale()) return
  const { lib, worker } = e.pdf!

  void e.task?.destroy()
  const task = lib.getDocument({ data: res.data, worker, ...ASSET_URLS })
  e.task = task
  task.onPassword = (update: (pw: string) => void, reason: number) => {
    if (stale()) return
    e.password = update
    patch(e.sessionId, {
      status: 'password',
      wrongPassword: reason === lib.PasswordResponses.INCORRECT_PASSWORD,
    })
  }

  let doc: PDFDocumentProxy
  try {
    doc = await task.promise
  } catch (err) {
    if (stale()) return
    // A half-written file during a rebuild reads as a broken PDF; the next write's
    // reload sorts it out, so a document already on screen stays there.
    if (e.doc) patch(e.sessionId, { gone: true })
    else patch(e.sessionId, { status: 'error', error: errorText(err) })
    watch(e)
    return
  }
  if (stale()) {
    void destroyDoc(doc)
    return
  }
  e.password = undefined
  const prev = e.doc
  // A reload lands where the reader was; a first load on the saved page, if any.
  if (prev) e.landing = here(e)
  e.doc = doc
  e.viewer!.setDocument(doc)
  e.links!.setDocument(doc, null)
  if (prev) void destroyDoc(prev)
  patch(e.sessionId, {
    status: 'ok',
    gone: false,
    error: undefined,
    wrongPassword: false,
    numPages: doc.numPages,
    findHits: NO_HITS,
  })
  watch(e)
  doc
    .getMetadata()
    .then((m) => {
      if (e.doc !== doc) return
      const title = (m.info as { Title?: unknown } | undefined)?.Title
      patch(e.sessionId, { title: typeof title === 'string' && title.trim() ? title.trim() : undefined })
    })
    .catch(() => {})
}

/** A document is let go of through the task that loaded it; the worker is shared and stays. */
function destroyDoc(doc: PDFDocumentProxy): Promise<void> {
  return doc.loadingTask.destroy().catch(() => {})
}

function errorText(err: unknown): string {
  const name = (err as { name?: string } | null)?.name
  if (name === 'InvalidPDFException') return "This file isn't a PDF, or it's damaged"
  if (name === 'ResponseException' || name === 'MissingPDFException') return "The file couldn't be read"
  return String((err as { message?: string } | null)?.message ?? err).slice(0, 200)
}

function watch(e: Entry): void {
  if (e.watching) return
  e.watching = true
  window.terminator.fsWatch(e.sessionId, e.path)
}

function handleFsChange(c: FsChange): void {
  const e = entries.get(c.sessionId)
  if (!e || c.path !== e.path || c.kind === 'dir') return
  if (c.kind === 'removed') {
    if (e.doc) patch(e.sessionId, { gone: true })
    else patch(e.sessionId, { status: 'missing' })
    return
  }
  // A rebuild writes in bursts (LaTeX rewrites its output several times over a run);
  // read once it has gone quiet.
  window.clearTimeout(e.reloadTimer)
  e.reloadTimer = window.setTimeout(() => void load(e), RELOAD_MS)
}

/** The reader's place, by page: survives a reload that changes the page count or sizes. */
function here(e: Entry): Landing | undefined {
  const v = e.viewer
  if (!v || !e.doc) return undefined
  const page = v.currentPageNumber
  const div = v.getPageView(page - 1)?.div as HTMLElement | undefined
  return { page, offset: div ? e.el.scrollTop - div.offsetTop : 0, scaleValue: v.currentScaleValue || 'auto' }
}

/** Once a document's pages exist: its scale, then where to stand in it. */
function land(e: Entry): void {
  const v = e.viewer
  if (!v) return
  const to = e.landing
  e.landing = undefined
  v.currentScaleValue = to?.scaleValue || 'auto'
  if (to && to.page > 1) {
    const page = Math.min(to.page, v.pagesCount)
    v.currentPageNumber = page
    const div = v.getPageView(page - 1)?.div as HTMLElement | undefined
    if (div) e.el.scrollTop = div.offsetTop + Math.max(0, to.offset)
  } else if (to) {
    e.el.scrollTop = Math.max(0, to.offset)
  }
  // A reload can land while the pane is parked, where scroll events aren't recorded.
  e.scroll = { top: e.el.scrollTop, left: e.el.scrollLeft }
  if (e.query) find(e.sessionId, e.query, false, false)
}

// ---- mounting ---------------------------------------------------------------

export function mount(sessionId: string, parent: HTMLElement): void {
  const e = entries.get(sessionId)
  if (!e) return
  if (e.el.parentElement !== parent) parent.appendChild(e.el)
  // Moving an element out of the document and back loses its scroll offset.
  e.el.scrollTop = e.scroll.top
  e.el.scrollLeft = e.scroll.left
  e.shown = true
  // Observed only while mounted: the holder is a different size, and refitting to
  // it would throw away the reader's place on the way back.
  e.resize.observe(e.el)
  e.viewer?.update()
}

export function park(sessionId: string): void {
  const e = entries.get(sessionId)
  if (!e) return
  e.shown = false
  e.resize.disconnect()
  ensureHolder().appendChild(e.el)
}

/**
 * The pane changed size. PDFViewer doesn't refit on its own, so a fitted scale
 * ("Page width", "Automatic") is asked for again. Never at zero width: a pane being
 * laid out measures 0 for a frame, and fitting to that is a nonsense scale.
 */
function refit(e: Entry): void {
  requestAnimationFrame(() => {
    const v = e.viewer
    if (!v || !e.doc || e.el.clientWidth === 0) return
    const cur = v.currentScaleValue
    if (PRESETS.has(cur)) v.currentScaleValue = cur
    v.update()
  })
}

export function focus(sessionId: string): void {
  entries.get(sessionId)?.el.focus({ preventScroll: true })
}

// ---- commands -----------------------------------------------------------------

export function goTo(sessionId: string, page: number): void {
  const v = entries.get(sessionId)?.viewer
  if (!v || !v.pagesCount) return
  v.currentPageNumber = Math.min(Math.max(1, Math.round(page)), v.pagesCount)
}

export function step(sessionId: string, by: 1 | -1): void {
  const v = entries.get(sessionId)?.viewer
  if (!v) return
  if (by > 0) v.nextPage()
  else v.previousPage()
}

export function setScale(sessionId: string, value: string): void {
  const v = entries.get(sessionId)?.viewer
  if (v && entries.get(sessionId)?.doc) v.currentScaleValue = value
}

/** One zoom step in or out; `origin` keeps that point under the pointer. */
export function zoom(sessionId: string, steps: number, origin?: [number, number]): void {
  const e = entries.get(sessionId)
  if (!e?.viewer || !e.doc) return
  e.viewer.updateScale({ steps, origin })
}

export function setRecolor(sessionId: string, on: boolean): void {
  entries.get(sessionId)?.el.classList.toggle('tm-pdf-recolor', on)
  patch(sessionId, { recolor: on })
}

/** Read the file again now — the toolbar's Reload, and Try again. */
export function reload(sessionId: string): void {
  const e = entries.get(sessionId)
  if (!e) return
  if (!e.doc) patch(sessionId, { status: 'loading', error: undefined })
  void load(e)
}

export function submitPassword(sessionId: string, password: string): void {
  const e = entries.get(sessionId)
  if (!e?.password) return
  patch(sessionId, { status: 'loading' })
  e.password(password)
}

/**
 * Find in the document. `again` steps to the next or previous match of the same
 * query; otherwise the search starts over, the way typing in a find box does.
 */
export function find(sessionId: string, query: string, again: boolean, previous: boolean): void {
  const e = entries.get(sessionId)
  if (!e?.bus) return
  e.query = query
  if (!query) {
    e.bus.dispatch('findbarclose', { source: null })
    patch(sessionId, { findHits: NO_HITS })
    return
  }
  e.bus.dispatch('find', {
    source: null,
    type: again ? 'again' : '',
    query,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: previous,
    matchDiacritics: false,
  })
}

export function closeFind(sessionId: string): void {
  const e = entries.get(sessionId)
  if (!e?.bus) return
  e.query = ''
  e.bus.dispatch('findbarclose', { source: null })
  patch(sessionId, { findHits: NO_HITS })
}

// ---- input ------------------------------------------------------------------

/**
 * A link in the document. Inside it (`#…`) is pdf.js's to follow; out of it goes
 * the way a link in a terminal does — the same check, the browser you chose, the
 * same "Ctrl to open" rule — because left alone it would try to navigate the app's
 * own window, which main refuses, and the click would do nothing at all.
 */
function onClick(e: Entry, ev: MouseEvent): void {
  const a = (ev.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!a || !e.el.contains(a)) return
  const href = a.getAttribute('href') ?? ''
  if (href.startsWith('#')) return
  ev.preventDefault()
  ev.stopPropagation()
  if (/^https?:/i.test(a.href) && clickOpens(ev)) void openWeb(a.href, undefined, e.sessionId)
}

/**
 * How much wheel makes one zoom step. A mouse wheel's notch is about 100, so it
 * still steps once a notch; a trackpad pinch arrives as Ctrl+wheel too, but as a
 * stream of small deltas, and stepping on each of them would zoom right past.
 */
const WHEEL_PER_STEP = 50
/** A pause this long ends a gesture: what's left of it doesn't carry into the next. */
const WHEEL_GESTURE_MS = 300
let wheelSum = 0
let wheelAt = 0

/** Ctrl/Cmd+wheel zooms around the pointer, as it does in every other PDF reader. */
function onWheel(e: Entry, ev: WheelEvent): void {
  if (!(ev.ctrlKey || ev.metaKey) || !e.doc) return
  ev.preventDefault()
  if (ev.timeStamp - wheelAt > WHEEL_GESTURE_MS) wheelSum = 0
  wheelAt = ev.timeStamp
  wheelSum += ev.deltaY
  if (Math.abs(wheelSum) < WHEEL_PER_STEP) return
  zoom(e.sessionId, wheelSum < 0 ? 1 : -1, [ev.clientX, ev.clientY])
  wheelSum = 0
}

// ---- theme ------------------------------------------------------------------

/** From applyTheme. Every colour but the pages' is a CSS variable already. */
export function setTheme(p: ThemePalette): void {
  setRecolorTheme(p)
}
