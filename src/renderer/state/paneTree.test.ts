/**
 * Tests for the split tree.
 *
 * `npm test`. No framework and no dependency: paneTree.ts is pure — no React, no
 * store, no DOM — so Node runs it directly, stripping the types as it goes
 * (Node 22.6+). That purity is the whole reason the arithmetic lives in its own
 * module, and this is what it buys.
 *
 * The randomised sweep at the bottom is the part that earns its keep. It found a
 * real bug during the original change: closing a pane could leave a row nested
 * directly inside a row, which looks identical on screen and only shows itself
 * when you drag a divider and two panes that appear to be side by side refuse to
 * move independently. A handful of hand-picked cases would not have caught it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  computeFractions,
  computeLayout,
  leafCount,
  removeAt,
  resetSizesAt,
  resizeAt,
  splitAt,
  type PaneNode,
  type Side,
} from './paneTree.ts'

const LEAF: PaneNode = { kind: 'leaf' }
const asSplit = (n: PaneNode): Extract<PaneNode, { kind: 'split' }> => {
  assert.equal(n.kind, 'split', 'expected a split node')
  return n as Extract<PaneNode, { kind: 'split' }>
}
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps

/** Every split's sizes sum to 1, match its children, and are all positive. */
function assertSizesSane(node: PaneNode, where = 'root'): void {
  if (node.kind === 'leaf') return
  assert.equal(node.sizes.length, node.children.length, `${where}: sizes/children mismatch`)
  assert.ok(near(node.sizes.reduce((a, b) => a + b, 0), 1), `${where}: sizes must sum to 1`)
  assert.ok(!node.sizes.some((s) => s <= 0), `${where}: sizes must be positive`)
  node.children.forEach((c, i) => assertSizesSane(c, `${where}.${i}`))
}

/** No split may hold a child split running the same way — see `flatten`. */
function isFlattened(node: PaneNode): boolean {
  if (node.kind === 'leaf') return true
  return node.children.every((c) => !(c.kind === 'split' && c.dir === node.dir) && isFlattened(c))
}

/** The panes must cover the whole area exactly once: no gaps, no overlaps. */
function tiles(tree: PaneNode): boolean {
  const boxes = computeFractions(tree)
  if (!near(boxes.reduce((a, f) => a + f.w * f.h, 0), 1, 1e-6)) return false
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const overX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const overY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (overX > 1e-9 && overY > 1e-9) return false
    }
  }
  return true
}

// ---- splitting --------------------------------------------------------------

test('a split puts the new pane on the side it was dropped', () => {
  assert.equal(splitAt(LEAF, 0, 'right').at, 1)
  assert.equal(splitAt(LEAF, 0, 'bottom').at, 1)
  assert.equal(splitAt(LEAF, 0, 'left').at, 0)
  assert.equal(splitAt(LEAF, 0, 'top').at, 0)
  assert.equal(asSplit(splitAt(LEAF, 0, 'right').tree).dir, 'row')
  assert.equal(asSplit(splitAt(LEAF, 0, 'bottom').tree).dir, 'col')
})

test('splitting the same way twice makes one row, not a row inside a row', () => {
  const first = splitAt(LEAF, 0, 'right')
  const second = splitAt(first.tree, first.at, 'right')
  const root = asSplit(second.tree)

  assert.equal(leafCount(second.tree), 3)
  assert.equal(root.children.length, 3, 'the three panes share one parent')
  assert.ok(isFlattened(second.tree))
  assert.equal(second.at, 2)
  // Only the pane that was split gives up room; the first keeps its half.
  assert.deepEqual(
    root.sizes.map((s) => +s.toFixed(4)),
    [0.5, 0.25, 0.25],
  )
  assertSizesSane(second.tree)
})

test('splitting the other way nests, because it has to', () => {
  const first = splitAt(LEAF, 0, 'right')
  const second = splitAt(first.tree, first.at, 'bottom')
  const root = asSplit(second.tree)

  assert.equal(root.dir, 'row')
  assert.equal(root.children.length, 2)
  assert.equal(asSplit(root.children[1]).dir, 'col')
  assert.equal(second.at, 2)
})

test('splitting a pane in the middle inserts it in the right place', () => {
  let tree = splitAt(LEAF, 0, 'right').tree
  tree = splitAt(tree, 1, 'right').tree
  const result = splitAt(tree, 1, 'left')

  assert.equal(leafCount(result.tree), 4)
  assert.equal(result.at, 1)
  assert.ok(isFlattened(result.tree))
  assertSizesSane(result.tree)
})

// ---- closing ----------------------------------------------------------------

test('closing one of two panes leaves the other by itself', () => {
  const tree = splitAt(LEAF, 0, 'right').tree
  const after = removeAt(tree, 1)
  assert.equal(after.kind, 'leaf')
  assert.equal(leafCount(after), 1)
})

test('a closed pane hands its space to its siblings, in proportion', () => {
  let tree = splitAt(LEAF, 0, 'right').tree
  tree = splitAt(tree, 1, 'right').tree // [0.5, 0.25, 0.25]
  const after = asSplit(removeAt(tree, 0)) // drop the big one

  assert.equal(leafCount(after), 2)
  assert.ok(near(after.sizes[0], 0.5) && near(after.sizes[1], 0.5))
  assertSizesSane(after)
})

test('closing a pane leaves no empty wrapper behind', () => {
  const first = splitAt(LEAF, 0, 'right')
  const nested = splitAt(first.tree, first.at, 'bottom') // row[leaf, col[leaf, leaf]]
  const after = asSplit(removeAt(nested.tree, 2))

  assert.equal(leafCount(after), 2)
  assert.equal(after.children[1].kind, 'leaf', 'the column collapsed into its survivor')
  assertSizesSane(after)
})

test('there is always at least one pane', () => {
  assert.equal(removeAt(LEAF, 0).kind, 'leaf')
})

// ---- resizing ---------------------------------------------------------------

test('a divider moves only the two panes it sits between', () => {
  let tree = splitAt(LEAF, 0, 'right').tree
  tree = splitAt(tree, 1, 'right').tree
  const after = asSplit(resizeAt(tree, [], 0, 0.3))

  assert.ok(near(after.sizes[0], 0.3))
  assert.ok(near(after.sizes[2], 0.25), 'the far pane is untouched')
  assertSizesSane(after)
})

test('a pane cannot be squeezed out of existence', () => {
  const tree = splitAt(LEAF, 0, 'right').tree
  const after = asSplit(resizeAt(tree, [], 0, 0.001))
  assert.ok(after.sizes[0] >= 0.08 - 1e-9, 'clamped to the minimum')
  assertSizesSane(after)
})

test('a resize that no longer makes sense changes nothing, and does not throw', () => {
  const tree = splitAt(LEAF, 0, 'right').tree
  // Paths are recomputed every render, but a resize racing a close could still
  // arrive stale — and a throw there would take the window down.
  assert.equal(resizeAt(tree, [9, 9], 0, 0.5), tree)
  assert.equal(resizeAt(tree, [], 5, 0.5), tree)
  assert.equal(resizeAt(LEAF, [], 0, 0.5), LEAF)
})

test('double-clicking a divider evens the split out', () => {
  let tree = splitAt(LEAF, 0, 'right').tree
  tree = resizeAt(tree, [], 0, 0.8)
  const after = asSplit(resetSizesAt(tree, []))
  assert.ok(near(after.sizes[0], 0.5) && near(after.sizes[1], 0.5))
})

// ---- geometry ---------------------------------------------------------------

test('a single pane goes edge to edge, with no gutter and no divider', () => {
  const { rects, dividers } = computeLayout(LEAF, 0)
  assert.equal(dividers.length, 0)
  assert.deepEqual(rects, [{ left: '0%', top: '0%', width: '100%', height: '100%' }])
})

test('two panes are separated by exactly one gutter', () => {
  const { rects, dividers } = computeLayout(splitAt(LEAF, 0, 'right').tree, 8)

  // 8px of padding at the window edge, 4px either side of the seam — so the two
  // panes are 8px apart and 8px from the frame, which is what the old CSS grid's
  // `padding: 8` + `gap: 8` produced.
  assert.deepEqual(rects[0], {
    left: 'calc(0% + 8px)',
    top: 'calc(0% + 8px)',
    width: 'calc(50% - 12px)',
    height: 'calc(100% - 16px)',
  })
  assert.equal(rects[1].left, 'calc(50% + 4px)')
  assert.equal(dividers.length, 1)
  assert.equal(dividers[0].dir, 'row')
  assert.equal(dividers[0].width, '8px', 'the handle fills the gutter it sits in')
})

test('a nested split gets its own divider, pointed the other way', () => {
  let tree = splitAt(LEAF, 0, 'right').tree
  tree = splitAt(tree, 1, 'bottom').tree
  const { rects, dividers } = computeLayout(tree, 8)

  assert.equal(rects.length, 3)
  assert.equal(dividers.length, 2)
  assert.deepEqual(
    dividers.map((d) => d.dir).sort(),
    ['col', 'row'],
  )
  assert.deepEqual(dividers.find((d) => d.dir === 'col')?.path, [1])
})

// ---- the invariant, under everything at once --------------------------------

test('300 runs of 40 mixed operations hold every invariant', () => {
  const SIDES: Side[] = ['left', 'right', 'top', 'bottom']
  // Deterministic, so a failure is reproducible from this seed.
  let seed = 12345
  const rnd = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return Math.abs(seed) / 2 ** 31
  }
  const pick = (n: number): number => Math.floor(rnd() * n) % n

  for (let run = 0; run < 300; run++) {
    let tree: PaneNode = LEAF
    let panes = 1
    for (let step = 0; step < 40; step++) {
      const where = `run ${run}, step ${step}`
      const roll = rnd()
      if (roll < 0.5 || panes === 1) {
        const result = splitAt(tree, pick(panes), SIDES[pick(4)])
        tree = result.tree
        panes++
        assert.ok(result.at >= 0 && result.at < panes, `${where}: new pane out of range`)
      } else if (roll < 0.8) {
        tree = removeAt(tree, pick(panes))
        panes = Math.max(1, panes - 1)
      } else {
        tree = resizeAt(tree, [], 0, rnd())
      }

      // The one that ties the tree to the store's flat `panes` array.
      assert.equal(leafCount(tree), panes, `${where}: leaf count drifted from pane count`)
      assertSizesSane(tree, where)
      assert.ok(isFlattened(tree), `${where}: a split ended up inside one of its own kind`)
      assert.ok(tiles(tree), `${where}: panes stopped covering the area exactly once`)
    }
  }
})
