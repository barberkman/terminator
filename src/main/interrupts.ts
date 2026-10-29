// What you do in a Claude session's terminal that no hook reports: stop a turn, or
// answer a permission dialog.
//
// Esc mid-turn, or Esc / No on a permission dialog, ends Claude's turn without a
// hook: `Stop` doesn't run for a user interrupt and nothing runs for a denied
// dialog. Claude does write the interrupt down, as a user record that reads
// "[Request interrupted by user]" (or "… for tool use"), so while a Claude session
// reads working or waiting its transcript is read on from where the turn began,
// and that record ends the turn (report-server.ts `turnInterrupted`). The keys
// themselves count too (`userTyped`): an Esc before Claude has answered leaves no
// record, and approving a dialog leaves nothing until the tool is done.
import type { Session } from '../shared/types'
import { transcriptSize } from './claude-turns'
import { readRange } from './conversation'
import { escPressed, permissionAnswered, turnInterrupted, turnPromptId } from './report-server'
import { getSession, onSessionChange } from './state'
import { conversationFile, isHumanPrompt, promptText, type Record_ } from './transcript'

const TICK_MS = 1_000
const MARKER = '[Request interrupted by user'

interface Watch {
  /** The turn being watched: an interrupt only ends the turn it belongs to. */
  promptId?: string
  file: string | null
  /** Read up to here; always at a line boundary. */
  offset: number
  /** Whether `offset` has been taken yet: until then a read would start at an older turn. */
  ready: boolean
}

const watching = new Map<string, Watch>()
let ticker: NodeJS.Timeout | null = null
let ticking = false

const active = (s: Session | undefined): s is Session =>
  !!s && s.kind === 'claude' && s.alive && (s.status === 'busy' || s.status === 'waiting')

async function begin(s: Session): Promise<void> {
  const w: Watch = { promptId: turnPromptId(s.id), file: null, offset: 0, ready: false }
  watching.set(s.id, w)
  w.file = await conversationFile(s)
  w.offset = await transcriptSize(w.file)
  w.ready = true
  if (!ticker) ticker = setInterval(() => void tick(), TICK_MS)
}

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    for (const [id, w] of [...watching]) {
      const s = getSession(id)
      if (!active(s)) {
        watching.delete(id)
        continue
      }
      if (!w.ready) continue
      // A conversation's first turn: the file appears with its first record.
      if (!w.file) w.file = await conversationFile(s)
      if (!w.file) continue
      const size = await transcriptSize(w.file)
      if (size <= w.offset) continue
      const text = (await readRange(w.file, w.offset, size - w.offset))?.toString('utf8') ?? ''
      // Only whole lines: the last one may still be being written.
      const end = text.lastIndexOf('\n')
      if (end < 0) continue
      w.offset += Buffer.byteLength(text.slice(0, end + 1))
      let interrupted = false
      for (const line of text.slice(0, end).split('\n')) {
        if (!line.includes('"user"')) continue
        let rec: Record_
        try {
          rec = JSON.parse(line) as Record_
        } catch {
          continue
        }
        if (rec.type !== 'user' || rec.isSidechain === true) continue
        if (promptText(rec).startsWith(MARKER)) interrupted = true
        // A prompt typed after the interrupt is a new turn, not this one.
        else if (isHumanPrompt(rec)) interrupted = false
      }
      if (interrupted && watching.get(id) === w && turnPromptId(id) === w.promptId) {
        watching.delete(id)
        turnInterrupted(id)
      }
    }
  } finally {
    ticking = false
    if (!watching.size && ticker) {
      clearInterval(ticker)
      ticker = null
    }
  }
}

/**
 * A key you pressed in a Claude session's terminal (Channels.ptyWrite — the
 * keyboard, never a script's typing). Two of them end something no hook reports:
 * Esc, and the Enter or number that answers a permission dialog.
 */
export function userTyped(id: string, data: string): void {
  if (getSession(id)?.kind !== 'claude') return
  if (data === '\x1b') escPressed(id)
  else if (data === '\r' || /^[1-9]$/.test(data)) permissionAnswered(id)
}

/** Watch each Claude turn from the moment it starts working until it's over. */
export function wireInterrupts(): void {
  onSessionChange((id, s) => {
    if (!active(s)) {
      watching.delete(id)
      return
    }
    const w = watching.get(id)
    // A new prompt mid-watch is a new turn: start again from where it begins.
    if (!w || w.promptId !== turnPromptId(id)) void begin(s)
  })
}
