import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConversationItem, Session, SessionStatus, ToolOutput } from '../../shared/types'
import { C, accentA, dotStyle, ink, sz } from '../theme'
import { Icon } from '../icons'
import { CodeBlock, renderMarkdown } from '../markdown'
import { quotePaths } from '../../shared/prompt-path'
import * as registry from '../term/registry'
import { useStore, type PendingPrompt } from '../state/store'
import { Composer, blockedReason } from './Composer'

/**
 * How often the view asks for what's been appended. Claude writes a transcript
 * record when a message completes, not per token, so a sub-second poll reads as
 * live. Each tick is one stat and (usually) no read — cheaper than a watcher
 * that would have to cope with the project directory not existing yet.
 */
const POLL_MS = 700

/** How much of a tool's output is shown before "show all" — copying takes it all. */
const OUTPUT_PREVIEW_LINES = 14

/**
 * How long a sent prompt may go unseen in the transcript before the view stops
 * claiming it's on its way. Only *quiet* time counts (see `PendingPrompt`), so
 * this is 20 seconds of a session with nothing to do — a long way past the
 * second or so a send normally takes, and unreachable while Claude is working.
 */
const PENDING_UNSURE_MS = 20_000
const PENDING_TICK_MS = 2_000

/** Clock slop between this process stamping a send and Claude stamping the record. */
const TS_SLACK_MS = 5_000

/** A stable empty list: a fresh array out of a selector would loop the store. */
const NO_PENDING: PendingPrompt[] = []

let nextPendingKey = 1

/**
 * How a sent prompt and a transcript record are compared. Whitespace is
 * collapsed because the TUI re-flows what it is given (tabs become its own tab
 * stops), so insisting on the bytes would leave a prompt pending forever.
 */
function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Retire the pendings whose prompts have turned up.
 *
 * Matching is by text, because a prompt has no id until Claude writes one. Two
 * guards keep that honest: only records stamped at or after the send can match
 * (so an identical prompt from an hour ago can't retire a fresh one), and each
 * record is claimed once (so two identical messages sent back to back resolve
 * against two records rather than both against the first).
 *
 * Three sweeps, strictest first:
 *   1. exact — the ordinary case.
 *   2. prefix — `promptText` joins every text block of a user record, so our text
 *      can legitimately be a prefix. Taken after exact so "go" can't eat the
 *      record belonging to "go on".
 *   3. contains, message only — the TUI rewrites an image path it recognises into
 *      `[Image #1]`, so a prompt sent with an attachment is *not* what lands in
 *      the transcript. The typed words survive; the path doesn't. Loose enough to
 *      need the two guards above, which is why it runs last and only for pendings
 *      that actually carried an attachment.
 *
 * Returns the same array when nothing matched, so an idle tick writes nothing.
 */
function reconcile(arrived: ConversationItem[], pendings: PendingPrompt[]): PendingPrompt[] {
  const prompts = arrived.filter((i) => i.kind === 'prompt')
  if (!prompts.length) return pendings
  const claimed = new Set<string>()
  const retired = new Set<string>()

  const sweep = (how: 'exact' | 'prefix' | 'message'): void => {
    for (const p of pendings) {
      if (retired.has(p.key)) continue
      const want = norm(how === 'message' ? (p.message ?? '') : p.text)
      if (!want) continue
      const hit = prompts.find((c) => {
        if (claimed.has(c.id)) return false
        const at = Date.parse(c.ts)
        if (!Number.isNaN(at) && at < p.sentAt - TS_SLACK_MS) return false
        const got = norm(c.text)
        if (how === 'exact') return got === want
        if (how === 'prefix') return got.startsWith(want)
        return got.includes(want)
      })
      if (!hit) continue
      claimed.add(hit.id)
      retired.add(p.key)
    }
  }
  sweep('exact')
  sweep('prefix')
  sweep('message')

  return retired.size ? pendings.filter((p) => !retired.has(p.key)) : pendings
}

function clock(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * A copy control that confirms in place. Every copy in this view is of the text
 * as Claude wrote it — the transcript's bytes, never anything the terminal drew.
 */
function CopyButton({
  text,
  label = 'Copy',
  title,
  hoverReveal = true,
}: {
  text: string
  label?: string
  title?: string
  hoverReveal?: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={hoverReveal ? 'cv-copy' : undefined}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        window.terminator.clipboardWrite(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      style={{
        padding: '3px 9px',
        background: C.panel2,
        border: `1px solid ${C.border3}`,
        borderRadius: 6,
        color: copied ? C.accentSoft : C.muted,
        font: 'inherit',
        fontSize: 10.5,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flex: 'none',
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

/** "…and 4200 more characters" — said out loud rather than silently swallowed. */
function ClippedNote({ shown }: { shown: number }): React.JSX.Element {
  return (
    <div style={{ fontSize: 10.5, color: C.faint2, marginTop: 4 }}>
      Cut after {shown.toLocaleString()} characters — read the rest in the terminal or the file.
    </div>
  )
}

function ToolOutputBlock({ output }: { output: ToolOutput }): React.JSX.Element {
  const [full, setFull] = useState(false)
  const lines = useMemo(() => output.text.split('\n'), [output.text])
  const long = lines.length > OUTPUT_PREVIEW_LINES
  const shown = full || !long ? output.text : lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n')

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 9.5, letterSpacing: 0.6, fontWeight: 700, color: output.isError ? C.danger : C.dim }}>
          {output.isError ? 'ERROR' : 'OUTPUT'}
        </span>
        {long && (
          <button
            onClick={() => setFull((v) => !v)}
            style={{
              padding: 0,
              background: 'transparent',
              border: 'none',
              color: C.accentSoft,
              font: 'inherit',
              fontSize: 10.5,
              cursor: 'pointer',
            }}
          >
            {full ? 'Show less' : `Show all ${lines.length} lines`}
          </button>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <CopyButton text={output.text} label="Copy output" hoverReveal={false} />
        </span>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          background: C.input,
          border: `1px solid ${output.isError ? C.danger : C.border2}`,
          borderRadius: 8,
          overflowX: 'auto',
          fontSize: 11.5,
          lineHeight: 1.5,
          color: C.body,
          whiteSpace: 'pre',
        }}
      >
        {shown}
      </pre>
      {output.clipped && <ClippedNote shown={output.text.length} />}
    </div>
  )
}

/**
 * A tool call: one line in the flow, opening to what it was given and what came
 * back. Collapsed by default — the working is available, not in the way.
 */
const ToolRow = memo(function ToolRow({
  item,
  output,
}: {
  item: Extract<ConversationItem, { kind: 'tool' }>
  output?: ToolOutput
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ margin: '3px 0' }}>
      <div
        className="cv-tool"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          borderRadius: 7,
          cursor: 'pointer',
          color: C.muted,
        }}
      >
        <span
          style={{
            display: 'flex',
            flex: 'none',
            color: C.faint2,
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.12s ease',
          }}
        >
          <Icon name="chevron" size={12} />
        </span>
        <span
          style={{
            flex: 'none',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: 0.3,
            color: output?.isError ? C.danger : C.textSubtle,
          }}
        >
          {item.name}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.summary}
        </span>
      </div>
      {open && (
        <div style={{ padding: '4px 8px 10px 28px' }}>
          {item.fields.map((f, i) => (
            <div key={`${item.id}-f${i}`} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 9.5, letterSpacing: 0.6, fontWeight: 700, color: C.dim, marginBottom: 4 }}>
                {f.label.toUpperCase()}
              </div>
              {f.code ? (
                <CodeBlock text={f.text} />
              ) : (
                <div style={{ fontSize: 12, color: C.body, wordBreak: 'break-all' }}>{f.text}</div>
              )}
              {f.clipped && <ClippedNote shown={f.text.length} />}
            </div>
          ))}
          {output ? (
            <ToolOutputBlock output={output} />
          ) : (
            <div style={{ fontSize: 11.5, color: C.faint2, marginTop: 6 }}>Still running…</div>
          )}
        </div>
      )}
    </div>
  )
})

/** Claude's reasoning, folded away — there when you want it, silent when you don't. */
const ThinkingRow = memo(function ThinkingRow({
  item,
}: {
  item: Extract<ConversationItem, { kind: 'thinking' }>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ margin: '3px 0' }}>
      <div
        className="cv-tool"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          borderRadius: 7,
          cursor: 'pointer',
          color: C.muted,
        }}
      >
        <span
          style={{
            display: 'flex',
            flex: 'none',
            color: C.faint2,
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.12s ease',
          }}
        >
          <Icon name="chevron" size={12} />
        </span>
        <span style={{ display: 'flex', flex: 'none', color: C.faint2 }}>
          <Icon name="sparkle" size={12} />
        </span>
        <span style={{ fontSize: 11.5, fontStyle: 'italic' }}>Thinking</span>
        <span style={{ marginLeft: 'auto' }}>
          <CopyButton text={item.text} />
        </span>
      </div>
      {open && (
        <div className="md-body" style={{ padding: '2px 8px 8px 28px', color: C.body }}>
          {renderMarkdown(item.text)}
        </div>
      )}
    </div>
  )
})

/** A prompt, shown as typed — its own line breaks, not the terminal's wrapping. */
const PromptBlock = memo(function PromptBlock({
  item,
}: {
  item: Extract<ConversationItem, { kind: 'prompt' }>
}): React.JSX.Element {
  return (
    <div
      style={{
        position: 'relative',
        margin: '4px 0 14px',
        padding: '10px 14px',
        background: accentA(0.06),
        borderLeft: `2px solid ${C.accentBorder}`,
        borderRadius: '0 8px 8px 0',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 9.5, letterSpacing: 0.7, fontWeight: 700, color: C.accentSoft }}>YOU</span>
        <span style={{ fontSize: 10.5, color: C.faint2 }}>{clock(item.ts)}</span>
        <span style={{ marginLeft: 'auto' }}>
          <CopyButton text={item.text} label="Copy prompt" />
        </span>
      </div>
      <div
        style={{
          fontSize: 12.5,
          lineHeight: 1.6,
          color: C.textHi,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          userSelect: 'text',
        }}
      >
        {item.text}
      </div>
    </div>
  )
})

/**
 * A prompt that has been typed into the session but hasn't come back out of the
 * transcript yet. Same shape as a real one at lower emphasis, so sending doesn't
 * leave a gap where the message seems to have gone nowhere.
 */
const PendingBlock = memo(function PendingBlock({
  item,
  busy,
  onTerminal,
  onDismiss,
}: {
  item: PendingPrompt
  busy: boolean
  onTerminal: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const unsure = item.state === 'unsure'
  return (
    <div
      style={{
        position: 'relative',
        margin: '4px 0 14px',
        padding: '10px 14px',
        background: accentA(0.04),
        borderLeft: `2px solid ${unsure ? C.border3 : C.accentBorder}`,
        borderRadius: '0 8px 8px 0',
        opacity: unsure ? 1 : 0.72,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 9.5, letterSpacing: 0.7, fontWeight: 700, color: C.accentSoft }}>YOU</span>
        <span style={{ fontSize: 10.5, color: C.faint2, fontStyle: 'italic' }}>
          {unsure ? 'not seen yet' : busy ? 'queued' : 'sending…'}
        </span>
      </div>
      <div
        style={{
          fontSize: 12.5,
          lineHeight: 1.6,
          color: C.textHi,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          userSelect: 'text',
        }}
      >
        {item.text}
      </div>
      {unsure && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 10.5, color: C.muted }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            This hasn’t turned up in the conversation — check the terminal.
          </span>
          <CopyButton text={item.text} label="Copy" hoverReveal={false} />
          <button onClick={onTerminal} style={pendingBtn}>
            Terminal
          </button>
          <button onClick={onDismiss} style={pendingBtn}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
})

const pendingBtn: React.CSSProperties = {
  padding: '3px 9px',
  background: C.panel2,
  border: `1px solid ${C.border3}`,
  borderRadius: 6,
  color: C.muted,
  font: 'inherit',
  fontSize: 10.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  flex: 'none',
}

/** Claude's prose, rendered — every fenced block arrives with its copy button. */
const MessageText = memo(function MessageText({
  item,
}: {
  item: Extract<ConversationItem, { kind: 'text' }>
}): React.JSX.Element {
  return <div className="md-body">{renderMarkdown(item.text)}</div>
})

/** One exchange: a prompt (when there is one) and everything Claude did after it. */
interface Turn {
  key: string
  prompt?: Extract<ConversationItem, { kind: 'prompt' }>
  body: ConversationItem[]
}

function toTurns(items: ConversationItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  for (const item of items) {
    if (item.kind === 'prompt') {
      current = { key: item.id, prompt: item, body: [] }
      turns.push(current)
      continue
    }
    // A resumed or branched session opens mid-conversation: hold the replies that
    // arrive before the first prompt rather than dropping them.
    if (!current) {
      current = { key: `pre-${item.id}`, body: [] }
      turns.push(current)
    }
    current.body.push(item)
  }
  return turns
}

/** Everything Claude said in prose in this turn — the "copy the whole answer" text. */
function replyText(turn: Turn): string {
  return turn.body
    .filter((i) => i.kind === 'text')
    .map((i) => i.text)
    .join('\n\n')
}

/**
 * What a turn actually shows. The filtering happens here rather than before
 * `toTurns` on purpose: a turn's key is derived from its first item, so filtering
 * upstream would change keys when the toggle flips, remounting every row and
 * losing which tool calls you had open.
 *
 * Only tool calls are hidden. Thinking was hidden with them at first and that was
 * wrong twice over: a collapsed one-line "Thinking" is not the wall of shell
 * commands the hiding was aimed at, and it is usually the first record a turn
 * writes — so hiding it took away the earliest sign that anything was happening.
 */
function visibleBody(turn: Turn, showTools: boolean): ConversationItem[] {
  return showTools ? turn.body : turn.body.filter((i) => i.kind !== 'tool')
}

/**
 * The footnote on a finished turn that spent itself entirely on tool calls — a
 * `git` archaeology turn that never said anything, say. Without it such a turn is
 * a prompt over dead air, which reads as broken rather than quiet.
 *
 * The *live* turn doesn't get this: `WorkingRow` carries the count while a turn is
 * running, so the number never appears twice.
 */
function HiddenWork({ count, onShow }: { count: number; onShow: () => void }): React.JSX.Element {
  return (
    <button
      className="cv-tool"
      onClick={onShow}
      title="Show tool calls"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 8px',
        borderRadius: 7,
        border: 'none',
        background: 'transparent',
        color: C.faint2,
        font: 'inherit',
        fontSize: 11.5,
        fontStyle: 'italic',
        cursor: 'pointer',
      }}
    >
      <span style={{ letterSpacing: 1.5 }}>···</span>
      <span>
        {count} step{count === 1 ? '' : 's'} hidden
      </span>
    </button>
  )
}

/** `74s` under two minutes, then `3m 02s` — short enough to sit inside a line. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 120) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/**
 * The only thing on screen that says a turn is actually running.
 *
 * It exists because three separate gaps used to leave the view looking stalled
 * after you pressed Enter. `sendPrompt` moves no status, so there is a window —
 * milliseconds if the session was idle, *minutes* if the prompt is queued behind a
 * running turn — where nothing has changed at all; that's what the `starting`
 * state covers. And the old signal only rendered for a turn with nothing visible,
 * so it vanished the moment Claude wrote one sentence, however long the tools then
 * ran for.
 *
 * The dot carries the liveness, not the words: `activity` oscillates between
 * `using X` and `working` and can sit unchanged for minutes on one long command or
 * a subagent run, so it is a label, and `cc-breathe` (via `dotStyle`) is the pulse.
 */
function WorkingRow({
  status,
  activity,
  since,
  hidden,
  onShowWorking,
}: {
  status: SessionStatus
  /** The session's own activity line, or '' while nothing has come back yet. */
  activity: string
  since: number
  /** Tool calls hidden in the live turn, 0 when there are none or they're shown. */
  hidden: number
  onShowWorking: () => void
}): React.JSX.Element {
  // The clock lives here rather than in the view so a tick re-renders one line
  // instead of every turn in the transcript.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  // Never the session's own status: this row renders during the window where that
  // status hasn't caught up yet, and `dotStyle` only animates `busy` and
  // `waiting` — so keying the dot off it would leave the one moment this row
  // exists for as a dot that doesn't move.
  const dot = status === 'waiting' ? 'waiting' : 'busy'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '2px 0 18px',
        padding: '4px 8px',
        fontSize: 11.5,
        color: C.muted,
      }}
    >
      <span style={dotStyle(dot, 7)} />
      <span style={{ fontStyle: 'italic' }}>{activity || 'sending…'}</span>
      <span style={{ color: C.faint2 }}>·</span>
      <span style={{ color: C.faint2, fontVariantNumeric: 'tabular-nums' }}>
        {elapsed(now - since)}
      </span>
      {hidden > 0 && (
        <button
          className="cv-tool"
          onClick={onShowWorking}
          title="Show tool calls"
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '3px 8px',
            borderRadius: 7,
            border: 'none',
            background: 'transparent',
            color: C.faint2,
            font: 'inherit',
            fontSize: 11.5,
            fontStyle: 'italic',
            cursor: 'pointer',
          }}
        >
          <span style={{ letterSpacing: 1.5 }}>···</span>
          {hidden} step{hidden === 1 ? '' : 's'} hidden
        </button>
      )}
    </div>
  )
}

function TurnBlock({
  turn,
  outputs,
  showTools,
  onShowWorking,
  working,
}: {
  turn: Turn
  outputs: Record<string, ToolOutput>
  showTools: boolean
  onShowWorking: () => void
  /** This is the newest turn and the session is still going — WorkingRow speaks for it. */
  working: boolean
}): React.JSX.Element {
  const reply = replyText(turn)
  const body = visibleBody(turn, showTools)
  const hidden = turn.body.length - body.length
  return (
    <section className="cv-msg" style={{ marginBottom: 18 }}>
      {turn.prompt && <PromptBlock item={turn.prompt} />}
      {!!reply && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 4px 2px' }}>
          <span style={{ fontSize: 9.5, letterSpacing: 0.7, fontWeight: 700, color: C.dim }}>CLAUDE</span>
          <span style={{ marginLeft: 'auto' }}>
            <CopyButton text={reply} label="Copy reply" title="Copy everything Claude wrote in this turn" />
          </span>
        </div>
      )}
      {body.map((item) => {
        if (item.kind === 'text') return <MessageText key={item.id} item={item} />
        if (item.kind === 'thinking') return <ThinkingRow key={item.id} item={item} />
        if (item.kind === 'tool') return <ToolRow key={item.id} item={item} output={outputs[item.toolId]} />
        return null
      })}
      {!working && !body.length && hidden > 0 && (
        <HiddenWork count={hidden} onShow={onShowWorking} />
      )}
    </section>
  )
}

function Empty({ text, sub }: { text: string; sub: string }): React.JSX.Element {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        color: C.dim,
      }}
    >
      <span style={{ opacity: 0.4 }}>
        <Icon name="note" size={26} />
      </span>
      <div style={{ fontSize: 13 }}>{text}</div>
      <div style={{ fontSize: 11.5, color: C.faint2 }}>{sub}</div>
    </div>
  )
}

/**
 * A Claude session's conversation as a document: prompts, replies as rendered
 * markdown (so every fenced block carries a copy button), and the working —
 * thinking and tool calls — folded away one line each.
 *
 * The text comes from the session's transcript file, not from the terminal, so a
 * copied block has its original indentation, no wrapping, and nothing the TUI
 * drew around it — and it reaches back to the first message rather than stopping
 * where the scrollback does.
 *
 * It lies over the live terminal rather than replacing it: the pane's xterm stays
 * mounted underneath, unresized and still receiving output, so switching back is
 * instant and the session never notices.
 */
export function ConversationView({ session }: { session: Session }): React.JSX.Element {
  const [items, setItems] = useState<ConversationItem[]>([])
  const [outputs, setOutputs] = useState<Record<string, ToolOutput>>({})
  const [exists, setExists] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [behind, setBehind] = useState(false)

  const scroller = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const offset = useRef(0)
  const busy = useRef(false)
  const following = useRef(true)
  /** Set when Relaunch was clicked *here*, so focus comes back when it works. */
  const relaunchedHere = useRef(false)
  const sessionId = session.id

  const toggleTranscript = useStore((s) => s.toggleTranscript)
  const showTools = useStore((s) => s.showTools)
  const toggleTools = useStore((s) => s.toggleTools)
  // `?? NO_PENDING` outside the selector: returning a fresh array from inside one
  // would loop useSyncExternalStore.
  const pendings = useStore((s) => s.pendings[sessionId]) ?? NO_PENDING

  const pull = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      const slice = await window.terminator.readConversation(sessionId, offset.current)
      offset.current = slice.nextOffset
      setExists(slice.exists)
      setLoaded(true)

      // Retire sent prompts in the same commit that shows the real ones. React
      // batches this continuation, so the pending block and its transcript
      // record never both appear — which is the whole "no duplicate, no gap".
      // Read the store rather than closing over it: `pull` is keyed on sessionId
      // alone, and a new dependency here would reset the byte offset and re-read
      // the whole transcript on every send.
      const st = useStore.getState()
      const held = st.pendings[sessionId]
      if (held?.length) {
        const next = slice.reset
          ? held.map((x) => (x.state === 'unsure' ? x : { ...x, state: 'unsure' as const }))
          : reconcile(slice.items, held)
        if (next !== held) st.setPendings(sessionId, next)
      }

      if (slice.reset) {
        setItems(slice.items)
        setOutputs(slice.outputs)
        return
      }
      if (slice.items.length) setItems((prev) => [...prev, ...slice.items])
      if (Object.keys(slice.outputs).length) setOutputs((prev) => ({ ...prev, ...slice.outputs }))
    } catch {
      // A transient read failure just means this tick had nothing; the next one retries.
    } finally {
      busy.current = false
    }
  }, [sessionId])

  // Start over whenever the pane changes session, then keep up by polling.
  useEffect(() => {
    offset.current = 0
    following.current = true
    setItems([])
    setOutputs({})
    setLoaded(false)
    setBehind(false)
    setAtBottom(true)
    void pull()
    const timer = setInterval(() => void pull(), POLL_MS)
    return () => clearInterval(timer)
  }, [pull])

  // A status change means the session just did something — don't wait for the tick.
  useEffect(() => {
    void pull()
  }, [session.status, pull])

  // Take focus off the terminal underneath: it's covered, and typing into a pane
  // you can't see would be worse than the wrapped selections this replaces. The
  // composer takes it rather than the scroller now — and the scroller stays as
  // the fallback, because focus has to land *somewhere* inside this view or the
  // global Esc handler can't find it.
  useEffect(() => {
    const el = composer.current ?? scroller.current
    el?.focus({ preventScroll: true })
    if (el instanceof HTMLTextAreaElement) {
      // Resume a restored draft at its end rather than in front of it.
      el.selectionStart = el.selectionEnd = el.value.length
    }
  }, [sessionId])

  // Relaunching from the composer is a deliberate act in this surface, so the
  // caret comes back when the session is up. Deliberately not a general "focus
  // whenever it becomes sendable": Claude finishing a turn is not the user's
  // action and must not pull focus out of wherever they actually are.
  useEffect(() => {
    if (!session.alive || !relaunchedHere.current) return
    relaunchedHere.current = false
    composer.current?.focus({ preventScroll: true })
  }, [session.alive])

  /** Stick to the tail, when that's where you were. Three callers need it. */
  const pin = useCallback(() => {
    const el = scroller.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [])

  // Follow the tail while pinned to the bottom; when you've scrolled up to read,
  // stay put and offer the jump instead of yanking the page.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (following.current) el.scrollTop = el.scrollHeight
    else if (items.length) setBehind(true)
    // `session.status` is in here for the working row: it appears and disappears
    // with the turn, which changes the flow's height without changing `items`.
  }, [items, pendings, showTools, session.status])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    following.current = bottom
    setAtBottom(bottom)
    if (bottom) setBehind(false)
  }

  const toBottom = () => {
    const el = scroller.current
    if (!el) return
    following.current = true
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
    setBehind(false)
  }

  const blocked = blockedReason(session)

  const toTerminal = useCallback(() => {
    toggleTranscript(sessionId)
    registry.focus(sessionId)
  }, [toggleTranscript, sessionId])

  const send = useCallback(
    async (raw: string) => {
      // Snap to the bottom first: sending your own message should always land you
      // where it will appear, even if you'd scrolled up to read.
      following.current = true
      setBehind(false)
      setAtBottom(true)

      // Attachments go in front of the message as paths — Claude reads the file
      // itself, which is what every other route into a session does too. Quoted
      // the way attachments.ts quotes them, so a path with spaces stays one path.
      const held = useStore.getState().attachments[sessionId] ?? []
      const paths = quotePaths(held.map((a) => a.path))
      const text = paths ? (raw.trim() ? `${paths}\n${raw}` : paths) : raw

      // Empty the box before the round trip, not after: while it still holds the
      // text a second Enter would send the same message twice.
      useStore.getState().setDraft(sessionId, '')
      if (held.length) useStore.getState().setAttachments(sessionId, [])

      const res = await window.terminator.sendPrompt(sessionId, text)
      const now = useStore.getState()
      if (!res.ok) {
        // Hand back the text *and* the attachments — a refusal must never cost
        // what you typed or make you find that screenshot again.
        now.setDraft(sessionId, raw)
        if (held.length) now.setAttachments(sessionId, held)
        now.pushToast({ tone: 'error', text: 'Not sent', sub: res.reason, icon: 'send' })
        return
      }
      // Keyed on what was actually written, not what was typed: sendPrompt
      // normalises newlines and strips control characters, and the transcript
      // will record the sanitised text.
      now.setPendings(sessionId, [
        ...(now.pendings[sessionId] ?? []),
        {
          key: `p${nextPendingKey++}`,
          text: res.text,
          // Only when paths were prepended: it's the fallback for the transcript
          // recording `[Image #1]` where the path was. See `reconcile`.
          message: paths ? raw.trim() : undefined,
          sentAt: Date.now(),
          quietMs: 0,
          state: 'pending',
        },
      ])
    },
    [sessionId],
  )

  const dropPending = useCallback(
    (key: string) => {
      const st = useStore.getState()
      st.setPendings(sessionId, (st.pendings[sessionId] ?? []).filter((p) => p.key !== key))
    },
    [sessionId],
  )

  // A prompt that never lands has to say so eventually — but only *quiet* time
  // counts. One sent mid-turn sits behind a turn that can run for minutes, and
  // calling that lost would be wrong every time. So while the session is busy
  // the clock doesn't run, and nothing is written to the store either.
  useEffect(() => {
    if (!pendings.length) return
    const timer = setInterval(() => {
      const st = useStore.getState()
      if (st.sessions[sessionId]?.status === 'busy') return
      const held = st.pendings[sessionId]
      if (!held?.length) return
      let changed = false
      const next = held.map((p) => {
        if (p.state === 'unsure') return p
        changed = true
        const quietMs = p.quietMs + PENDING_TICK_MS
        return quietMs >= PENDING_UNSURE_MS
          ? { ...p, quietMs, state: 'unsure' as const }
          : { ...p, quietMs }
      })
      if (changed) st.setPendings(sessionId, next)
    }, PENDING_TICK_MS)
    return () => clearInterval(timer)
  }, [pendings.length, sessionId])

  const turns = useMemo(() => toTurns(items), [items])
  // A turn with nothing left to draw is dropped rather than rendered as an empty
  // block — which is what a resumed session's leading tool run, or a turn that
  // only ran commands, would otherwise become with the working hidden.
  const shown = useMemo(
    () => turns.filter((t) => t.prompt || visibleBody(t, showTools).length > 0),
    [turns, showTools],
  )
  // Exchanges are prompts, not turns: the synthetic turn a resumed session opens
  // with isn't one, and the count mustn't wobble when the toggle flips.
  const exchanges = useMemo(() => turns.reduce((n, t) => n + (t.prompt ? 1 : 0), 0), [turns])

  // A turn is in flight while Claude says so — or, before the first hook has come
  // back, while a prompt we sent is still unaccounted for. Without that second
  // clause the row would be absent for exactly the seconds after Enter when you
  // most need it, and for the whole time a queued prompt waits its turn.
  // `alive` matters: killing a session with a prompt in flight would otherwise
  // leave a clock counting up next to a dead pane until the pending gave up.
  const running =
    session.alive && (session.status === 'busy' || pendings.some((p) => p.state === 'pending'))

  // When the turn began, from the session itself — so opening the conversation on
  // a session that has been grinding for four minutes says so, instead of
  // counting from zero because this view only just started watching. Falls back
  // to now for the window before Claude has confirmed the turn at all.
  const sentAt = pendings.find((p) => p.state === 'pending')?.sentAt
  const firstSeen = useRef(0)
  if (running && !firstSeen.current) firstSeen.current = Date.now()
  else if (!running && firstSeen.current) firstSeen.current = 0
  const runningSince = session.busySince ?? sentAt ?? firstSeen.current

  // The live turn's hidden tool calls, offered on the row rather than as a
  // separate footnote so the count is never drawn twice. Read from `turns`, not
  // `shown`: a turn with nothing visible is dropped from `shown`, and that is
  // exactly the turn whose hidden count this is.
  const liveTurn = turns.length ? turns[turns.length - 1] : null
  const liveHidden = useMemo(() => {
    if (showTools || !liveTurn) return 0
    return liveTurn.body.length - visibleBody(liveTurn, showTools).length
  }, [liveTurn, showTools])

  return (
    <div
      data-conversation-for={sessionId}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
        background: C.bg,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 12px',
          borderBottom: `1px solid ${C.border}`,
          background: ink(0.02),
          flex: 'none',
        }}
      >
        <span style={{ display: 'flex', color: C.accent }}>
          <Icon name="note" size={13} />
        </span>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: C.textStrong }}>Conversation</span>
        <span style={{ fontSize: 10.5, color: C.faint2 }}>
          {exchanges ? `${exchanges} exchange${exchanges === 1 ? '' : 's'}` : ''}
        </span>
        <button
          onClick={toggleTools}
          title={showTools ? 'Hide tool calls' : 'Show tool calls — what Claude ran to get here'}
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '5px 11px',
            borderRadius: 7,
            // Longhand borderColor, never the `border` shorthand: the palette is
            // var() references, and a shorthand holding one would be dropped
            // rather than updated when this button's on-state changes it.
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: showTools ? C.accentBorder : C.border2,
            background: showTools ? accentA(0.12) : 'transparent',
            color: showTools ? C.accentSoft : C.textSubtle,
            font: 'inherit',
            fontSize: 11.5,
            cursor: 'pointer',
          }}
        >
          <Icon name="hammer" size={13} />
          Tools
        </button>
        <button
          onClick={() => {
            toggleTranscript(sessionId)
            registry.focus(sessionId)
          }}
          title="Back to the live terminal"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '5px 11px',
            borderRadius: 7,
            border: `1px solid ${C.border2}`,
            background: 'transparent',
            color: C.textSubtle,
            font: 'inherit',
            fontSize: 11.5,
            cursor: 'pointer',
          }}
        >
          <Icon name="terminal" size={13} />
          Terminal
        </button>
      </div>

      {/* The scroller gets a wrapper of its own so the "New messages" pill can be
          positioned against the *reading area* rather than the whole view: against
          the view it would sit on top of the composer, and chasing the composer's
          changing height with a measurement is the alternative nobody wants. */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        ref={scroller}
        onScroll={onScroll}
        tabIndex={-1}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '16px 20px 28px',
          outline: 'none',
          userSelect: 'text',
        }}
      >
        {!loaded ? null : !exists ? (
          <Empty
            text="No saved conversation yet"
            sub="Send this session a prompt and it will show up here."
          />
        ) : !turns.length ? (
          <Empty text="Nothing to read yet" sub="The conversation is still empty." />
        ) : !shown.length ? (
          <Empty text="Nothing but tool calls so far" sub="Turn on Tools to see what ran." />
        ) : (
          <div style={{ maxWidth: 900, margin: '0 auto' }}>
            {shown.map((turn) => (
              <TurnBlock
                key={turn.key}
                turn={turn}
                outputs={outputs}
                showTools={showTools}
                onShowWorking={toggleTools}
                // Keyed off the same turn WorkingRow reports for, so the two can
                // never both claim the hidden count.
                working={running && turn.key === liveTurn?.key}
              />
            ))}
          </div>
        )}
        {!!pendings.length && (
          <div style={{ maxWidth: 900, margin: '0 auto' }}>
            {pendings.map((p) => (
              <PendingBlock
                key={p.key}
                item={p}
                busy={session.status === 'busy'}
                onTerminal={toTerminal}
                onDismiss={() => dropPending(p.key)}
              />
            ))}
          </div>
        )}
        {/* Last of everything, so it sits right above the composer — where you're
            already looking when you press Enter. Below the queued messages, too:
            those are waiting on what this row is describing. */}
        {loaded && running && (
          <div style={{ maxWidth: 900, margin: '0 auto' }}>
            <WorkingRow
              status={session.status}
              activity={
                session.status === 'busy' || session.status === 'waiting' ? session.activity : ''
              }
              since={runningSince}
              hidden={liveHidden}
              onShowWorking={toggleTools}
            />
          </div>
        )}
      </div>

      {behind && !atBottom && (
        <button
          onClick={toBottom}
          style={{
            position: 'absolute',
            bottom: 14,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '7px 14px',
            borderRadius: 20,
            border: `1px solid ${C.accentBorder}`,
            background: C.panel,
            boxShadow: C.shadowMenu,
            color: C.accentSoft,
            font: 'inherit',
            fontSize: 11.5,
            cursor: 'pointer',
          }}
        >
          <span style={{ display: 'flex', width: sz(12), height: sz(12) }}>
            <Icon name="chevron" size={12} />
          </span>
          New messages
        </button>
      )}
      </div>

      <Composer
        session={session}
        blocked={blocked}
        onSend={send}
        onHeight={pin}
        onRelaunch={() => {
          relaunchedHere.current = true
        }}
        inputRef={composer}
      />
    </div>
  )
}
