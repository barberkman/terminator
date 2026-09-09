// Turning a typed argument line into an argv array, and back.
//
// Browser arguments are *stored* as a real array and handed to spawn() one
// element at a time, so nothing is ever re-split on the way to the process. But
// an array is a miserable thing to type into a text box, so Settings shows one
// line and converts here. Quoting works the way a shell trains you to expect —
// `--profile-directory="Profile 1"` is one argument — without a shell being
// involved anywhere.

/** Split a typed argument line into argv entries, honouring "…" and '…'. */
export function parseArgs(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      // An empty pair ("" ) is still an argument, so remember it was opened.
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started || cur) out.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += ch
  }
  if (started || cur) out.push(cur)
  return out
}

/** Render argv back as one editable line, quoting only what needs it. */
export function formatArgs(args: string[]): string {
  return args
    .map((a) => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, '')}"` : a))
    .join(' ')
}
