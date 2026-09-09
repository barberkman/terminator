// Reading a Claude session's transcript as a *conversation* — the source for the
// in-app transcript view.
//
// Same file transcript.ts already reads for branching (one JSONL record per line
// at ~/.claude/projects/<cwd-encoded>/<session-id>.jsonl), and the same defensive
// posture: it is Claude's private storage, so unknown record types and unknown
// tools are skipped or shown generically rather than assumed away. Nothing here
// ever writes.
//
// Reading it — rather than scraping the painted terminal — is the whole point:
// the text is exactly what Claude sent, with its own indentation and no line
// wrapping, and it reaches back to the first message instead of stopping at the
// terminal's scrollback.
//
// Reads are incremental. The renderer keeps a byte offset and asks for what was
// appended since; a transcript only grows, so that is a cheap tail read. The
// trailing line can be half-written while the session runs, so parsing always
// stops at the last newline and leaves the remainder for the next read.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import type {
  ConversationItem,
  ConversationSlice,
  ToolField,
  ToolOutput,
} from '../shared/types'
import { isHumanPrompt, promptText, transcriptPath, type Record_ } from './transcript'

/**
 * Tool input/output text longer than this is cut. A `Read` of a big file or a
 * noisy test run would otherwise cross IPC in full on every open; prose and code
 * blocks — what the copy buttons are for — are never touched by this.
 */
const MAX_FIELD_CHARS = 60_000

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Collapse to a single line for the one-line summary of a tool call. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

function clip(text: string): { text: string; clipped: boolean } {
  return text.length > MAX_FIELD_CHARS
    ? { text: text.slice(0, MAX_FIELD_CHARS), clipped: true }
    : { text, clipped: false }
}

// ---- tool calls ------------------------------------------------------------

/**
 * The one line a tool call is worth in the flow of the conversation: the command
 * that ran, the file that was touched, the pattern that was searched. An unknown
 * tool (an MCP server's, say) falls back to its one string argument, or its JSON.
 */
function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return oneLine(str(input.command) || str(input.description))
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return str(input.file_path)
    case 'NotebookEdit':
      return str(input.notebook_path) || str(input.file_path)
    case 'Glob':
    case 'Grep': {
      const where = str(input.path)
      return oneLine(str(input.pattern) + (where ? ` in ${where}` : ''))
    }
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return oneLine(str(input.query))
    case 'Task':
    case 'Agent':
      return oneLine(str(input.description) || str(input.subagent_type))
    case 'TodoWrite': {
      const n = Array.isArray(input.todos) ? input.todos.length : 0
      return `${n} item${n === 1 ? '' : 's'}`
    }
    default: {
      const strings = Object.values(input).filter((v) => typeof v === 'string') as string[]
      return oneLine(strings.length === 1 ? strings[0] : safeJson(input))
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? ''
  } catch {
    return ''
  }
}

/**
 * What an opened tool row shows. Anything worth copying (a command, a file's new
 * contents, the two sides of an edit) is a code block, so it arrives with the
 * same copy button a fenced block in Claude's prose gets.
 */
function toolFields(name: string, input: Record<string, unknown>): ToolField[] {
  const fields: ToolField[] = []
  const add = (label: string, text: string, code: boolean) => {
    if (!text.trim()) return
    fields.push({ label, code, ...clip(text) })
  }

  switch (name) {
    case 'Bash':
      add('Command', str(input.command), true)
      add('Description', str(input.description), false)
      break
    case 'Edit':
      add('File', str(input.file_path), false)
      add('Replaced', str(input.old_string), true)
      add('With', str(input.new_string), true)
      break
    case 'Write':
      add('File', str(input.file_path), false)
      add('Contents', str(input.content), true)
      break
    case 'Read':
      add('File', str(input.file_path), false)
      break
    case 'Glob':
    case 'Grep':
      add('Pattern', str(input.pattern), true)
      add('Path', str(input.path), false)
      break
    case 'WebFetch':
      add('URL', str(input.url), false)
      add('Prompt', str(input.prompt), false)
      break
    case 'Task':
    case 'Agent':
      add('Agent', str(input.subagent_type), false)
      add('Prompt', str(input.prompt), false)
      break
    default:
      add('Input', safeJson(input), true)
  }
  // A known tool called with something unexpected would otherwise show nothing.
  if (!fields.length) add('Input', safeJson(input), true)
  return fields
}

/** A tool result's text: a plain string, or the text blocks it came back as. */
function outputText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') parts.push('[image]')
  }
  return parts.join('\n')
}

// ---- records -> items ------------------------------------------------------

function collect(
  rec: Record_,
  items: ConversationItem[],
  outputs: Record<string, ToolOutput>,
): void {
  // Subagent traffic runs in its own thread of the file; the Task row that
  // started it stands for it, rather than interleaving two conversations.
  if (rec.isSidechain === true) return
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : ''
  const uuid = typeof rec.uuid === 'string' ? rec.uuid : `n${items.length}`
  const msg = rec.message as { role?: string; content?: unknown } | undefined

  if (rec.type === 'user') {
    // Tool results ride on user records. They belong to the call that asked for
    // them, not to the flow of the conversation, so they're filed by tool id.
    if (Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue
        const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        outputs[b.tool_use_id] = { ...clip(outputText(b.content)), isError: b.is_error === true }
      }
    }
    // Same "what the user actually typed" rule the branch picker uses.
    if (isHumanPrompt(rec)) items.push({ kind: 'prompt', id: uuid, ts, text: promptText(rec) })
    return
  }

  if (rec.type !== 'assistant' || !Array.isArray(msg?.content)) return
  msg.content.forEach((block, i) => {
    if (!block || typeof block !== 'object') return
    const b = block as {
      type?: string
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: unknown
    }
    const id = `${uuid}#${i}`
    if (b.type === 'text' && b.text?.trim()) {
      items.push({ kind: 'text', id, ts, text: b.text })
    } else if (b.type === 'thinking' && b.thinking?.trim()) {
      items.push({ kind: 'thinking', id, ts, text: b.thinking })
    } else if (b.type === 'tool_use' && b.name) {
      const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>
      items.push({
        kind: 'tool',
        id,
        ts,
        toolId: typeof b.id === 'string' ? b.id : id,
        name: b.name,
        summary: toolSummary(b.name, input),
        fields: toolFields(b.name, input),
      })
    }
  })
}

// ---- reading ---------------------------------------------------------------

/** Bytes [at, at+len) of a file, or null if it can't be read. */
function readRange(file: string, at: number, len: number): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.allocUnsafe(len)
    let got = 0
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, at + got)
      if (n <= 0) break
      got += n
    }
    return got === len ? buf : buf.subarray(0, got)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // already gone
      }
    }
  }
}

/**
 * The conversation appended to `sessionId`'s transcript since byte offset `from`.
 * `from` 0 reads the whole file. Never throws: an unreadable or absent transcript
 * comes back as an empty slice, which the view shows as "no conversation yet".
 */
export function readConversation(sessionId: string, cwd: string, from: number): ConversationSlice {
  const nothing = (over: Partial<ConversationSlice> = {}): ConversationSlice => ({
    items: [],
    outputs: {},
    nextOffset: from,
    reset: false,
    exists: false,
    ...over,
  })

  const file = transcriptPath(sessionId, cwd)
  if (!existsSync(file)) return nothing()
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return nothing()
  }

  // A file shorter than where we last stopped isn't the file we were reading —
  // start over and tell the renderer to drop what it had.
  const reset = from > size
  const start = reset ? 0 : from
  if (start === size) return nothing({ exists: true, nextOffset: size, reset })

  const buf = readRange(file, start, size - start)
  if (!buf) return nothing({ exists: true })
  // Stop at the last complete line: the session may be mid-write.
  const lastNl = buf.lastIndexOf(0x0a)
  if (lastNl < 0) return nothing({ exists: true, nextOffset: start, reset })
  const chunk = buf.subarray(0, lastNl + 1)

  const items: ConversationItem[] = []
  const outputs: Record<string, ToolOutput> = {}
  for (const line of chunk.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let rec: Record_
    try {
      rec = JSON.parse(line) as Record_
    } catch {
      continue
    }
    collect(rec, items, outputs)
  }
  return { items, outputs, nextOffset: start + chunk.length, reset, exists: true }
}
