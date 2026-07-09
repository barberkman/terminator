// Account-wide rate-limit usage, kept globally rather than per-session: the
// limits are per-account, so any Claude session's statusLine reports the same
// numbers. Stored in memory only (no persistence) and broadcast to the renderer
// so the footer can show usage regardless of which session is focused.
import { Channels } from '../shared/channels'
import type { GlobalUsage } from '../shared/types'
import { emitUsage } from './state'

let latest: GlobalUsage = {}

export function get(): GlobalUsage {
  return latest
}

/** Merge a report into the global usage and broadcast it, if anything changed. */
export function update(patch: Partial<GlobalUsage>): void {
  const next: GlobalUsage = { ...latest }
  if (patch.fiveHourPct !== undefined) next.fiveHourPct = patch.fiveHourPct
  if (patch.fiveHourResetsAt !== undefined) next.fiveHourResetsAt = patch.fiveHourResetsAt
  if (patch.weeklyPct !== undefined) next.weeklyPct = patch.weeklyPct
  if (patch.weeklyResetsAt !== undefined) next.weeklyResetsAt = patch.weeklyResetsAt

  const changed =
    next.fiveHourPct !== latest.fiveHourPct ||
    next.fiveHourResetsAt !== latest.fiveHourResetsAt ||
    next.weeklyPct !== latest.weeklyPct ||
    next.weeklyResetsAt !== latest.weeklyResetsAt
  // Nothing changed (or a report with no rate-limit data at all): don't broadcast,
  // so `updatedAt` only ever gets set once we actually have usage to show.
  if (!changed) return

  next.updatedAt = Date.now()
  latest = next
  emitUsage(Channels.usageUpdated, latest)
}
