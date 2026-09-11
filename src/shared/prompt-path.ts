/**
 * How a file path is written into a Claude prompt.
 *
 * Shared because it is applied in two processes for the same session: main types
 * a dropped path straight into the TUI (`attachments.ts`), and the renderer folds
 * an attached path into the message the composer sends. The two must agree — if
 * they quote differently, the same file reaches Claude as two different strings.
 *
 * Not shell quoting. These characters go into Claude's own input box, which reads
 * the whole thing as text, so `$`, backticks and quotes need no escaping; only
 * whitespace has to be held together, because a bare space would otherwise split
 * one path into two.
 */
export function quotePath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

/** Several paths as one run of prompt text. */
export function quotePaths(paths: string[]): string {
  return paths.map(quotePath).join(' ')
}
