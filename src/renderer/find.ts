// Ctrl/Cmd+F, and the engine behind the conversation view's half of it.
//
// Two views can be searched and they do not share an engine, because they can't:
// a browser pane's text lives inside a <webview>, its own frame tree, and only
// Chromium can search it (`findInPage`). The conversation's text is DOM this
// renderer owns. So what's shared is the part that is genuinely the same — the
// key that opens a bar and the shape of the counter — and the rest is per view.
//
// The conversation engine is the CSS Custom Highlight API rather than wrapping
// matches in <mark>. That choice is load-bearing three times over:
//
//   • It doesn't touch the DOM. The view re-renders from `pull()` every 700ms and
//     memoizes its rows on item identity; injecting elements would invalidate
//     those memos and fight reconciliation on every keystroke.
//   • A match routinely straddles several text nodes — `renderInline` splits a
//     sentence across <strong>, <em>, <code> and bare strings — and a Range spans
//     them for free. A <mark> would have to be split at every boundary, and a
//     match crossing **bold** couldn't be expressed at all.
//   • Highlights paint; they don't reflow. Nothing moves under the reader.
//
// The cost is that ranges point at text nodes React is free to replace, so they
// have to be rebuilt after the view changes shape — see `useDomFind`.

import { useCallback, useEffect, useRef, useState } from 'react'
import { modalOpen } from './state/store'

/** A find bar's counter. `index` is 1-based; both are 0 when nothing matched. */
export interface FindHits {
  index: number
  total: number
}

export const NO_HITS: FindHits = { index: 0, total: 0 }

/**
 * Ctrl/Cmd+F, bound while `active`.
 *
 * Capture phase for the same reason Alt+1..9 uses it (App.tsx): xterm forwards
 * Ctrl-combos to the pty, and a conversation is an overlay *on top of* a live
 * terminal — so focus can be on the terminal underneath while the thing you mean
 * to search is what's on screen. Bubble phase would lose the race there.
 *
 * `active` is what keeps this honest, and it's why there's no `.xterm` bail: the
 * two callers pass "this pane is focused and is showing something searchable",
 * so in a terminal or editor pane nothing is bound at all and Ctrl+F still
 * reaches the program in the pane, or CodeMirror's own search.
 */
export function useFindKeys(active: boolean, onOpen: () => void): void {
  const open = useRef(onOpen)
  open.current = onOpen
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      // `code`, not `key`, so a non-US layout still finds the F — the same
      // layout-independence `codeToAccel` is built on.
      if (e.code !== 'KeyF' || e.altKey || e.shiftKey) return
      if (!(e.ctrlKey || e.metaKey)) return
      if (modalOpen()) return
      e.preventDefault()
      e.stopPropagation()
      open.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])
}

// ——— the conversation's engine: text nodes in, Ranges out ———

/**
 * Elements that start a new run of text. Two paragraphs are not one string, and
 * without a seam between them a search for "endresult" would match the end of one
 * and the start of the next. Inline elements are deliberately absent: the whole
 * point is that a match crosses <strong> and <code> without noticing.
 *
 * A tag list rather than `getComputedStyle().display`, which is a forced layout
 * per node and would cost more than this whole pass.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

function blockOf(node: Node): Element | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (BLOCK_TAGS.has(el.tagName)) return el
  }
  return null
}

/** The searchable text under `root`, flattened, with each node's start offset. */
interface TextIndex {
  text: string
  nodes: Text[]
  starts: number[]
}

/**
 * Flatten what's on screen into one string.
 *
 * Three things are left out, and the first two are the point rather than
 * housekeeping. This view's standing promise is that the text is the real text —
 * the transcript's bytes, never anything drawn around them — and searching the
 * raw DOM would break it: `copy` would hit every code block's Copy button,
 * `output` the OUTPUT label above a tool result, and `show all 40 lines` a
 * sentence nobody wrote. So every <button> is dropped, along with anything marked
 * `data-find-skip` for the few labels that aren't buttons.
 *
 * Third, unless `includeAsides`: `data-find-aside`, which marks the bodies of the
 * working — an opened tool call, an unfolded Thinking row. Those are excluded so
 * that "what the find searches" doesn't depend on which rows happen to be open,
 * and so the matches in them can be counted separately and offered.
 */
function indexText(root: HTMLElement, includeAsides: boolean): TextIndex {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  let lastBlock: Element | null = null

  const skip = includeAsides ? 'button, [data-find-skip]' : 'button, [data-find-skip], [data-find-aside]'
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement
      if (!parent || !(node as Text).data) return NodeFilter.FILTER_REJECT
      // FILTER_REJECT can't prune a subtree here — a SHOW_TEXT walker only ever
      // visits leaves — so the ancestry is asked about per node instead.
      return parent.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    },
  })

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text
    const block = blockOf(t)
    if (lastBlock && block !== lastBlock) text += '\n'
    lastBlock = block
    starts.push(text.length)
    nodes.push(t)
    text += t.data
  }
  return { text, nodes, starts }
}

/** Which node a flat offset falls in, and where inside it. */
function locate(ix: TextIndex, offset: number): { node: Text; at: number } {
  let lo = 0
  let hi = ix.starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ix.starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  const node = ix.nodes[lo]
  // Clamped because a match can end exactly at a seam, whose newline belongs to
  // no node at all.
  return { node, at: Math.min(offset - ix.starts[lo], node.data.length) }
}

/** Every match of `query` in what's rendered under `root`, in document order. */
export function findRanges(root: HTMLElement, query: string, includeAsides: boolean): Range[] {
  if (!query) return []
  const ix = indexText(root, includeAsides)
  if (!ix.text) return []

  // Case-insensitive by lowercasing both sides — but only when that's safe.
  // A handful of characters (Turkish dotted capital I, some ligatures) change
  // *length* when lowercased, which would shift every offset after them and put
  // the highlights on the wrong words. Rare enough to fall back rather than
  // carry an offset table for.
  const lowered = ix.text.toLowerCase()
  const exact = lowered.length !== ix.text.length
  const hay = exact ? ix.text : lowered
  const needle = exact ? query : query.toLowerCase()
  if (!needle) return []

  const out: Range[] = []
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    const s = locate(ix, at)
    const e = locate(ix, at + needle.length)
    const range = document.createRange()
    range.setStart(s.node, s.at)
    range.setEnd(e.node, e.at)
    out.push(range)
  }
  return out
}

const ALL = 'find-all'
const CURRENT = 'find-current'

/**
 * Whether this Chromium has the Highlight API. It does — but a feature that
 * throws on load is a worse failure than one that quietly stops tinting, and the
 * counting and jumping work without it.
 */
const canPaint = typeof CSS !== 'undefined' && 'highlights' in CSS

export function paintFind(all: readonly Range[], current: Range | null): void {
  if (!canPaint) return
  if (!all.length) {
    clearFind()
    return
  }
  const wash = new Highlight()
  // Added one at a time rather than spread into the constructor: a one-letter
  // query on a long transcript can match thousands of times, and that many
  // arguments is a stack overflow waiting to happen.
  for (const r of all) wash.add(r)
  CSS.highlights.set(ALL, wash)

  if (!current) {
    CSS.highlights.delete(CURRENT)
    return
  }
  const one = new Highlight(current)
  // The wash covers the current match too, and the registry paints in
  // registration order — without a priority the wash repaints over it and the
  // one match you're looking at is the one you can't pick out.
  one.priority = 1
  CSS.highlights.set(CURRENT, one)
}

export function clearFind(): void {
  if (!canPaint) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

/**
 * Bring a match into view, if it isn't already.
 *
 * A Range has no `scrollIntoView`, hence the arithmetic. Scrolling only when the
 * match is outside the margin keeps stepping through neighbours from jerking the
 * page around for each one.
 *
 * Writing `scrollTop` is deliberate rather than incidental: it fires the
 * scroller's own `onScroll`, which is what drops tail-follow. So jumping to a
 * match half an hour back unpins the view exactly as dragging the scrollbar does,
 * and the "New messages" pill takes over — no special case anywhere for it.
 */
export function scrollRangeIntoView(range: Range, scroller: HTMLElement): void {
  const rect = range.getBoundingClientRect()
  // A zero-area rect is a range in a subtree that isn't laid out; there is
  // nowhere to scroll to.
  if (!rect.height && !rect.width) return
  const box = scroller.getBoundingClientRect()
  const margin = Math.min(80, box.height / 4)
  if (rect.top < box.top + margin) scroller.scrollTop -= box.top + margin - rect.top
  else if (rect.bottom > box.bottom - margin) scroller.scrollTop += rect.bottom - (box.bottom - margin)
}

/**
 * The first match at or below what's on screen.
 *
 * Where a new query starts. Jumping to match #1 instead would throw you to the
 * top of a three-hour conversation the moment you typed a common word — the
 * opposite of what searching from where you're reading should do.
 */
function firstAtOrBelow(ranges: readonly Range[], scroller: HTMLElement): number {
  const top = scroller.getBoundingClientRect().top
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i].getBoundingClientRect()
    if (r.height && r.bottom >= top) return i
  }
  return 0
}

/** How long to let the view settle before re-finding. */
const SETTLE_MS = 120

/**
 * A live find over a scrolling region of the DOM.
 *
 * The hard part is that the document changes underneath it five ways, and only
 * two of them are props: the 700ms poll appending to a running turn, the Tools
 * toggle, a tool row being opened, "Show all N lines", and the working row's
 * clock ticking. So a MutationObserver is the trigger rather than a dependency
 * array — it catches all five without knowing about any of them. It's connected
 * only while there's a query, so an unopened find bar costs nothing.
 */
export function useDomFind(
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  query: string,
  includeAsides: boolean,
): { hits: FindHits; go: (delta: number) => void } {
  const ranges = useRef<Range[]>([])
  const at = useRef(0)
  const [hits, setHits] = useState(NO_HITS)

  const repaint = useCallback(() => {
    const list = ranges.current
    const i = list.length ? Math.min(at.current, list.length - 1) : 0
    at.current = i
    paintFind(list, list[i] ?? null)
    const index = list.length ? i + 1 : 0
    // Only when it actually changed. `setHits` re-renders the view, which mutates
    // the DOM, which wakes the observer, which lands back here — a fresh object
    // every time would be a loop that never settles.
    setHits((prev) => (prev.index === index && prev.total === list.length ? prev : { index, total: list.length }))
  }, [])

  const recompute = useCallback(
    (jump: boolean) => {
      const root = scrollerRef.current
      if (!root || !query) {
        ranges.current = []
        at.current = 0
        clearFind()
        setHits((prev) => (prev.total === 0 && prev.index === 0 ? prev : NO_HITS))
        return
      }
      const list = findRanges(root, query, includeAsides)
      ranges.current = list
      if (jump && list.length) {
        at.current = firstAtOrBelow(list, root)
        scrollRangeIntoView(list[at.current], root)
      }
      repaint()
    },
    [query, includeAsides, repaint, scrollerRef],
  )

  // A new query, or the working being brought in, starts the search over and
  // jumps. Everything else (below) keeps the place it had.
  useEffect(() => {
    recompute(true)
  }, [recompute])

  useEffect(() => {
    const root = scrollerRef.current
    if (!root || !query) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => recompute(false), SETTLE_MS)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
    }
  }, [query, recompute, scrollerRef])

  // Leaving the view — Esc, the Terminal button, the pane being reused — must
  // take the tint with it; the registry is the document's, not this component's.
  useEffect(() => clearFind, [])

  const go = useCallback(
    (delta: number) => {
      const list = ranges.current
      if (!list.length) return
      at.current = (at.current + delta + list.length) % list.length
      const root = scrollerRef.current
      if (root) scrollRangeIntoView(list[at.current], root)
      repaint()
    },
    [repaint, scrollerRef],
  )

  return { hits, go }
}
