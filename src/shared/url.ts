// What counts as a URL this app will open, in one place.
//
// It lives in shared/ rather than in main because there are now two ways a link
// can be acted on: handed to a browser (main launches it) and shown in an in-app
// browser pane (the renderer mounts it). The second never reaches the main
// process, and it must not therefore be the one path that skips the check.

/** Long enough for any real link, short enough that nothing silly gets launched. */
export const MAX_URL_LENGTH = 2048

/**
 * The only URLs this app will open. Returns the normalised form to launch with,
 * or null — callers must treat null as "refuse", never as "pass it through".
 */
export function webUrl(raw: string): string | null {
  if (!raw || raw.length > MAX_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.toString()
}

/**
 * How a web URL is recognised in free text — terminal output and Claude's markdown
 * alike, so the two can't drift on what counts as a link. A factory, not a shared
 * constant: a global regex carries `lastIndex` between uses, and two call sites
 * sharing one instance would silently skip matches.
 */
export function webUrlRe(flags = 'g'): RegExp {
  return new RegExp(/\bhttps?:\/\/[^\s<>"'`\\^{}|]+/, flags)
}
