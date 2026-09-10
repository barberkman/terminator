import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CustomTheme, sanitizeSeed } from '../shared/themes'

// The user's own themes, deliberately kept out of settings.json: a theme is some
// seventy colours and settings.json is a file people edit by hand. Same shape as
// persistence.ts — one cached copy, a tolerant read, an atomic write.

/** Plenty for anyone, and a ceiling a runaway import can't grow the file past. */
const MAX_THEMES = 64

function file(): string {
  return join(app.getPath('userData'), 'themes.json')
}

/** First id wins, and the list is capped. */
function dedupe(list: CustomTheme[]): CustomTheme[] {
  const seen = new Set<string>()
  const out: CustomTheme[] = []
  for (const seed of list) {
    if (seen.has(seed.id)) continue
    seen.add(seed.id)
    out.push(seed)
    if (out.length >= MAX_THEMES) break
  }
  return out
}

function clean(list: unknown[]): CustomTheme[] {
  return dedupe(list.map((entry) => sanitizeSeed(entry)).filter((s): s is CustomTheme => s !== null))
}

let cached: CustomTheme[] | null = null

export function loadCustomThemes(): CustomTheme[] {
  if (cached) return cached
  cached = []
  const f = file()
  if (existsSync(f)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'))
      // Every entry is re-validated on the way in, so a file somebody hand-edited
      // into nonsense costs the themes it broke and nothing else.
      if (Array.isArray(parsed)) cached = clean(parsed)
    } catch {
      // A corrupt file costs the custom themes, never the app.
    }
  }
  return cached
}

/**
 * Replace the whole set — the renderer owns create/duplicate/rename/delete, the
 * same way it owns `projects` and `links.browsers`. The payload is input like any
 * other, so it goes through the sanitiser again on this side.
 */
export function saveCustomThemes(list: unknown): CustomTheme[] {
  const next = clean(Array.isArray(list) ? list : [])
  cached = next
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    const f = file()
    const tmp = `${f}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, f)
  } catch {
    // Best effort, same as the session list.
  }
  return next
}
