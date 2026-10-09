// Quick Open's matcher: does every character of the query appear in a path, in
// order — and how good a match is it. The ranking is VS Code's idea of good: the
// file's own name over its folders, a run of characters over scattered ones, and
// characters that start a word (`fT` in `FileTree`, `ep` in `editor-pane`) over ones
// that happen to sit in the middle of one.

export interface FuzzyMatch {
  score: number
  /** Indexes into the path of the characters that matched, ascending — for highlighting. */
  positions: number[]
}

/** Whether `text[i]` starts a word: after a separator, or a capital after a lower-case letter. */
function startsWord(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text[i - 1]
  if ('/\\_-. '.includes(prev)) return true
  const c = text[i]
  return c !== c.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase()
}

/**
 * Match `q` (already lower-cased) in `text`. The tightest window wins: forward to the
 * earliest place the whole query can end, then back from there to the latest place it
 * can start — so `ts` in `test.ts` is the extension, not the `t` and `s` of `test`.
 */
function matchIn(q: string, text: string, lower: string): FuzzyMatch | null {
  let j = 0
  let end = -1
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] !== q[j]) continue
    if (++j === q.length) {
      end = i
      break
    }
  }
  if (end < 0) return null
  let start = end
  j = q.length - 1
  for (let i = end; i >= 0 && j >= 0; i--) {
    if (lower[i] === q[j]) {
      j--
      start = i
    }
  }
  const positions: number[] = []
  j = 0
  for (let i = start; i <= end && j < q.length; i++) {
    if (lower[i] === q[j]) {
      positions.push(i)
      j++
    }
  }
  let score = 0
  for (let k = 0; k < positions.length; k++) {
    const p = positions[k]
    score += 1
    if (startsWord(text, p)) score += 8
    if (k > 0 && positions[k - 1] === p - 1) score += 5
  }
  // Characters skipped inside the match cost a little each.
  score -= (end - start + 1 - q.length) * 0.5
  return { score, positions }
}

/**
 * Match `query` against a `/`-separated path. Spaces in the query are ignored, and case
 * doesn't matter. Without a `/` in the query the file's name is tried first, and a match
 * there outranks one that needs the folders; with one, it's the whole path from the start.
 */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, '').toLowerCase()
  if (!q) return { score: 0, positions: [] }
  const lower = path.toLowerCase()
  // Shorter paths win a tie: `index.ts` before `deep/down/index.ts`.
  const lengthCost = path.length * 0.05
  if (!q.includes('/')) {
    const base = path.lastIndexOf('/') + 1
    const m = matchIn(q, path.slice(base), lower.slice(base))
    if (m) {
      const prefix = m.positions[0] === 0 ? 10 : 0
      return { score: m.score + 20 + prefix - lengthCost, positions: m.positions.map((p) => p + base) }
    }
  }
  const m = matchIn(q, path, lower)
  return m && { score: m.score - lengthCost, positions: m.positions }
}
