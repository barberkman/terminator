/**
 * The shape of the splits — and nothing else.
 *
 * This module is deliberately pure: no React, no store, no DOM. It answers two
 * questions and neither of them needs any of those. What does the tree look like
 * after a split, a close or a drag of a divider? And where on screen does each
 * pane end up? Keeping it separate is what makes the awkward half of this feature
 * (the arithmetic) testable without an app around it.
 *
 * ## Why a tree at all, when the panes are a flat array
 *
 * `panes` in the store stays a flat list of session ids, and PaneGrid keeps
 * rendering one never-reordered child list from it. That is not an accident of
 * history — it is the only shape that keeps a browser pane's <webview> alive,
 * because a webview's guest is destroyed if its element is moved, and "moved"
 * includes a reorder within the same parent (see BrowserPane). A layout built
 * from nested <div>s would re-parent every browser pane on every split.
 *
 * So the tree here never renders anything. It decides *geometry*: `computeLayout`
 * turns it into one absolute rect per pane, and those rects go out as plain CSS.
 * The DOM never changes shape no matter what the layout does.
 *
 * ## How the tree and the flat array stay in step
 *
 * A leaf carries no data at all — no id, no index. Instead:
 *
 *   **the tree's leaves, read depth-first left-to-right, are index-aligned with
 *   `panes`.** Leaf ordinal `i` shows `panes[i]`.
 *
 * So `leafCount(tree) === panes.length` is the invariant, and "insert a leaf at
 * ordinal k" always means "splice `panes` at k" as well. One source of truth for
 * ordering, and no ids to keep synchronised between two structures.
 */

export type SplitDir = 'row' | 'col'

/** Which edge of a pane a session was dropped on. The centre isn't a split. */
export type Side = 'left' | 'right' | 'top' | 'bottom'

/**
 * `dir: 'row'` lays its children out side by side, `'col'` stacks them. `sizes`
 * is one fraction per child and always sums to 1 — fractions rather than pixels
 * so a window resize costs nothing and needs no recalculation.
 */
export type PaneNode =
  | { kind: 'leaf' }
  | { kind: 'split'; dir: SplitDir; sizes: number[]; children: PaneNode[] }

/** Smallest share of its parent a pane may be dragged down to. */
export const MIN_FRACTION = 0.08

export const SINGLE: PaneNode = { kind: 'leaf' }

export function leafCount(node: PaneNode): number {
  if (node.kind === 'leaf') return 1
  let n = 0
  for (const c of node.children) n += leafCount(c)
  return n
}

function dirOf(side: Side): SplitDir {
  return side === 'left' || side === 'right' ? 'row' : 'col'
}

/** Whether the new pane goes before the one being split, in tree order. */
function isBefore(side: Side): boolean {
  return side === 'left' || side === 'top'
}

function equalSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
}

// ---- mutation ---------------------------------------------------------------

/**
 * Collapse a split into its parent when the two run the same way, and a split
 * with one child into that child.
 *
 * This is the rule that keeps the layout honest. A row nested directly inside a
 * row looks identical on screen but behaves differently the moment you touch a
 * divider: the outer one resizes the whole inner group as a unit, so two panes
 * that appear to be side by side refuse to move independently. Flattening is
 * what makes "one divider between two panes" mean one thing.
 *
 * Both operations below can create that shape — splitting a pane that already
 * sits in a same-direction row, and closing a pane whose sibling wrapper then
 * collapses — so it is normalised here, in one place, rather than guarded
 * against at each call site. A merged child's grandchildren keep their
 * proportion of the slot their parent occupied, so nothing visibly moves.
 *
 * Children are only ever spliced in place, in order, so leaf ordinals are
 * unchanged — which is what lets `splitAt` compute its `at` before this runs.
 */
function flatten(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') return node
  const children: PaneNode[] = []
  const sizes: number[] = []
  for (let i = 0; i < node.children.length; i++) {
    const child = flatten(node.children[i])
    const share = node.sizes[i] ?? 1 / node.children.length
    if (child.kind === 'split' && child.dir === node.dir) {
      for (let j = 0; j < child.children.length; j++) {
        children.push(child.children[j])
        sizes.push(share * (child.sizes[j] ?? 1 / child.children.length))
      }
    } else {
      children.push(child)
      sizes.push(share)
    }
  }
  if (children.length === 1) return children[0]
  return { ...node, children, sizes }
}

/**
 * Split the pane at leaf ordinal `index`, returning the new tree and the ordinal
 * the *new* pane landed on — which is what the caller splices into `panes`.
 *
 * The new pane takes half of what the pane it split was using, so every other
 * pane keeps its size. Dropping three sessions left to right gives one row of
 * three, not a row inside a row inside a row — see `flatten`.
 */
export function splitAt(tree: PaneNode, index: number, side: Side): { tree: PaneNode; at: number } {
  const r = splitNode(tree, index, side)
  return { tree: flatten(r.node), at: r.at }
}

function splitNode(node: PaneNode, index: number, side: Side): { node: PaneNode; at: number } {
  if (node.kind === 'leaf') {
    const fresh: PaneNode = { kind: 'leaf' }
    const before = isBefore(side)
    return {
      node: {
        kind: 'split',
        dir: dirOf(side),
        sizes: [0.5, 0.5],
        children: before ? [fresh, node] : [node, fresh],
      },
      at: before ? 0 : 1,
    }
  }

  // `offset` is the leaf ordinal the child about to be examined starts at, so a
  // child's local index is `index - offset` and any ordinal it reports back is
  // turned global by adding it again.
  let offset = 0
  for (let c = 0; c < node.children.length; c++) {
    const child = node.children[c]
    const n = leafCount(child)
    if (index < offset + n) {
      // No same-direction special case here: replacing the leaf with a 50/50
      // split and letting `flatten` merge it into this one gives each new pane
      // half of the donor's share, which is the same answer with one rule
      // instead of two.
      const r = splitNode(child, index - offset, side)
      const children = node.children.slice()
      children[c] = r.node
      return { node: { ...node, children }, at: offset + r.at }
    }
    offset += n
  }
  // Ordinal past the end of the tree — nothing to split, and no reason to throw.
  return { node, at: index }
}

/**
 * Drop the pane at leaf ordinal `index`. Its space goes to its remaining
 * siblings in proportion to what they already had, and a split left holding a
 * single child is replaced by that child — so closing a pane leaves no empty
 * wrapper behind, however deep the nesting was.
 *
 * Removing the last leaf gives back a bare leaf rather than nothing: there is
 * always exactly one pane, even when it is the empty one.
 */
export function removeAt(tree: PaneNode, index: number): PaneNode {
  const next = removeNode(tree, index)
  return next === null ? { kind: 'leaf' } : flatten(next)
}

/** null means "this subtree is now empty" — the caller unhooks it. */
function removeNode(node: PaneNode, index: number): PaneNode | null {
  if (node.kind === 'leaf') return null

  let offset = 0
  for (let c = 0; c < node.children.length; c++) {
    const n = leafCount(node.children[c])
    if (index < offset + n) {
      const replaced = removeNode(node.children[c], index - offset)
      const children = node.children.slice()
      const sizes = node.sizes.slice()
      if (replaced !== null) {
        // The child survived, smaller inside. Its slot and share don't change.
        children[c] = replaced
        return { ...node, children, sizes }
      }
      children.splice(c, 1)
      const freed = sizes[c]
      sizes.splice(c, 1)
      if (children.length === 1) return children[0]
      const total = sizes.reduce((a, b) => a + b, 0)
      const next = total > 0 ? sizes.map((s) => s + (freed * s) / total) : equalSizes(sizes.length)
      return { ...node, children, sizes: next }
    }
    offset += n
  }
  return node
}

/** The split node at `path` (a child-index path from the root), if there is one. */
function splitAtPath(
  tree: PaneNode,
  path: number[],
): Extract<PaneNode, { kind: 'split' }> | null {
  let node: PaneNode = tree
  for (const step of path) {
    if (node.kind !== 'split') return null
    const next = node.children[step]
    if (!next) return null
    node = next
  }
  return node.kind === 'split' ? node : null
}

function replaceAtPath(tree: PaneNode, path: number[], next: PaneNode): PaneNode {
  if (!path.length) return next
  if (tree.kind !== 'split') return tree
  const [head, ...rest] = path
  const child = tree.children[head]
  if (!child) return tree
  const children = tree.children.slice()
  children[head] = replaceAtPath(child, rest, next)
  return { ...tree, children }
}

/**
 * Move the divider between children `i` and `i + 1` of the split at `path`, so
 * that the first of the pair takes `fraction` of the parent. Only those two
 * change — their sum is fixed, which is what stops a drag deep in the tree from
 * nudging panes on the other side of the window.
 *
 * `min` is the smallest share either may be squeezed to; callers pass the
 * pixel minimum converted against the parent's measured extent.
 *
 * A path that no longer resolves returns the tree untouched rather than
 * throwing. Paths are recomputed on every render and only ever used within a
 * single gesture, but a resize racing a close is exactly the case where a throw
 * would take the window down.
 */
export function resizeAt(
  tree: PaneNode,
  path: number[],
  i: number,
  fraction: number,
  min: number = MIN_FRACTION,
): PaneNode {
  const node = splitAtPath(tree, path)
  if (!node) return tree
  if (i < 0 || i + 1 >= node.sizes.length) return tree
  const pair = node.sizes[i] + node.sizes[i + 1]
  // No room to honour the minimum on both sides: leave it alone rather than
  // picking a winner.
  if (pair < min * 2) return tree
  const a = Math.min(Math.max(fraction, min), pair - min)
  const sizes = node.sizes.slice()
  sizes[i] = a
  sizes[i + 1] = pair - a
  return replaceAtPath(tree, path, { ...node, sizes })
}

/** Even shares for the split at `path` — what a double-click on a divider does. */
export function resetSizesAt(tree: PaneNode, path: number[]): PaneNode {
  const node = splitAtPath(tree, path)
  if (!node) return tree
  return replaceAtPath(tree, path, { ...node, sizes: equalSizes(node.children.length) })
}

// ---- geometry ---------------------------------------------------------------

export interface PaneRect {
  left: string
  top: string
  width: string
  height: string
}

export interface Divider {
  /** Child-index path to the split this divider belongs to. */
  path: number[]
  /** The divider sits between children `index` and `index + 1`. */
  index: number
  dir: SplitDir
  left: string
  top: string
  width: string
  height: string
  /**
   * Everything a drag needs, so the handle never has to walk the tree back.
   *
   * `start` and `span` are the parent split's extent along its own axis as
   * fractions of the whole grid — enough to turn a pointer position into a
   * fraction of the parent, which is what `sizes` is measured in. `before` is
   * the share taken by the children ahead of this pair, and `pair` is what the
   * two on either side of this divider have between them: the drag moves the
   * boundary inside `pair` and touches nothing else.
   */
  start: number
  span: number
  before: number
  pair: number
}

/** Which sides of a box touch the outside of the grid rather than another pane. */
interface Edges {
  left: boolean
  top: boolean
  right: boolean
  bottom: boolean
}

interface Frac {
  x: number
  y: number
  w: number
  h: number
}

const pct = (v: number): string => `${+(v * 100).toFixed(4)}%`

/** `x%`, or `calc(x% + Npx)` — the plain form when there's no offset to add. */
function offset(v: number, px: number): string {
  if (!px) return pct(v)
  return `calc(${pct(v)} ${px < 0 ? '-' : '+'} ${Math.abs(px)}px)`
}

/**
 * One absolute rect per pane, plus the dividers between them.
 *
 * Percentages nest perfectly and survive any window size; the gutter doesn't,
 * because it is a fixed number of pixels that must not scale. So each pane is a
 * percentage box inset by pixels inside a `calc()`. The inset is the full gap on
 * a side that faces the window edge and half of it on a side that faces another
 * pane — which adds up to exactly one gap between any two panes, and reproduces
 * the `padding: 8` + `gap: 8` the old CSS grid had.
 *
 * Pass `gap: 0` for a single pane so it goes edge to edge, as it always has.
 */
export function computeLayout(
  tree: PaneNode,
  gap: number,
): { rects: PaneRect[]; dividers: Divider[] } {
  const rects: PaneRect[] = []
  const dividers: Divider[] = []
  const half = gap / 2

  const walk = (node: PaneNode, box: Frac, edges: Edges, path: number[]): void => {
    if (node.kind === 'leaf') {
      const l = edges.left ? gap : half
      const t = edges.top ? gap : half
      const r = edges.right ? gap : half
      const b = edges.bottom ? gap : half
      rects.push({
        left: offset(box.x, l),
        top: offset(box.y, t),
        width: offset(box.w, -(l + r)),
        height: offset(box.h, -(t + b)),
      })
      return
    }

    const row = node.dir === 'row'
    const span = row ? box.w : box.h
    const last = node.children.length - 1
    let run = 0

    for (let c = 0; c <= last; c++) {
      const size = node.sizes[c] ?? 1 / node.children.length
      const childBox: Frac = row
        ? { x: box.x + run * span, y: box.y, w: size * span, h: box.h }
        : { x: box.x, y: box.y + run * span, w: box.w, h: size * span }
      const childEdges: Edges = row
        ? {
            left: edges.left && c === 0,
            right: edges.right && c === last,
            top: edges.top,
            bottom: edges.bottom,
          }
        : {
            top: edges.top && c === 0,
            bottom: edges.bottom && c === last,
            left: edges.left,
            right: edges.right,
          }
      walk(node.children[c], childBox, childEdges, [...path, c])

      run += size
      if (c < last) {
        // Centred on the boundary, as thick as the gutter it sits in. It spans
        // the parent's whole extent, inset like a pane on the two sides that
        // face the window, so it never overhangs the padding.
        const at = row ? box.x + run * span : box.y + run * span
        const t = edges.top ? gap : half
        const b = edges.bottom ? gap : half
        const l = edges.left ? gap : half
        const rr = edges.right ? gap : half
        const drag = {
          start: row ? box.x : box.y,
          span,
          // `run` already includes this child, so stepping back over it gives
          // the share belonging to everything ahead of the pair.
          before: run - size,
          pair: size + (node.sizes[c + 1] ?? 1 / node.children.length),
        }
        dividers.push(
          row
            ? {
                path,
                index: c,
                dir: 'row',
                left: offset(at, -half),
                top: offset(box.y, t),
                width: `${gap}px`,
                height: offset(box.h, -(t + b)),
                ...drag,
              }
            : {
                path,
                index: c,
                dir: 'col',
                left: offset(box.x, l),
                top: offset(at, -half),
                width: offset(box.w, -(l + rr)),
                height: `${gap}px`,
                ...drag,
              },
        )
      }
    }
  }

  walk(tree, { x: 0, y: 0, w: 1, h: 1 }, { left: true, top: true, right: true, bottom: true }, [])
  return { rects, dividers }
}

/**
 * The fractional box of every pane, ignoring the gutter — what the drop overlay
 * hit-tests against. It works in numbers rather than the CSS strings above
 * because it has to answer "which pane is the pointer in, and how far across it".
 */
export function computeFractions(tree: PaneNode): Frac[] {
  const out: Frac[] = []
  const walk = (node: PaneNode, box: Frac): void => {
    if (node.kind === 'leaf') {
      out.push(box)
      return
    }
    const row = node.dir === 'row'
    const span = row ? box.w : box.h
    let run = 0
    for (let c = 0; c < node.children.length; c++) {
      const size = node.sizes[c] ?? 1 / node.children.length
      walk(
        node.children[c],
        row
          ? { x: box.x + run * span, y: box.y, w: size * span, h: box.h }
          : { x: box.x, y: box.y + run * span, w: box.w, h: size * span },
      )
      run += size
    }
  }
  walk(tree, { x: 0, y: 0, w: 1, h: 1 })
  return out
}

export type { Frac as PaneFraction }
