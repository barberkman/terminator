import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConversationItem, Session, ToolOutput } from '../../shared/types'
import { C, accentA, ink, sz } from '../theme'
import { Icon } from '../icons'
import { CodeBlock, renderMarkdown } from '../markdown'
import * as registry from '../term/registry'
import { useStore } from '../state/store'

/**
 * How often the view asks for what's been appended. Claude writes a transcript
 * record when a message completes, not per token, so a sub-second poll reads as
 * live. Each tick is one stat and (usually) no read — cheaper than a watcher
 * that would have to cope with the project directory not existing yet.
 */
const POLL_MS = 700

/** How much of a tool's output is shown before "show all" — copying takes it all. */
const OUTPUT_PREVIEW_LINES = 14

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

function TurnBlock({ turn, outputs }: { turn: Turn; outputs: Record<string, ToolOutput> }): React.JSX.Element {
  const reply = replyText(turn)
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
      {turn.body.map((item) => {
        if (item.kind === 'text') return <MessageText key={item.id} item={item} />
        if (item.kind === 'thinking') return <ThinkingRow key={item.id} item={item} />
        if (item.kind === 'tool') return <ToolRow key={item.id} item={item} output={outputs[item.toolId]} />
        return null
      })}
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
  const offset = useRef(0)
  const busy = useRef(false)
  const following = useRef(true)
  const toggleTranscript = useStore((s) => s.toggleTranscript)

  const sessionId = session.id

  const pull = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      const slice = await window.terminator.readConversation(sessionId, offset.current)
      offset.current = slice.nextOffset
      setExists(slice.exists)
      setLoaded(true)
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
  // you can't see would be worse than the wrapped selections this replaces.
  useEffect(() => {
    scroller.current?.focus({ preventScroll: true })
  }, [sessionId])

  // Follow the tail while pinned to the bottom; when you've scrolled up to read,
  // stay put and offer the jump instead of yanking the page.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (following.current) el.scrollTop = el.scrollHeight
    else if (items.length) setBehind(true)
  }, [items])

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

  const turns = useMemo(() => toTurns(items), [items])

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
          {turns.length ? `${turns.length} exchange${turns.length === 1 ? '' : 's'}` : ''}
        </span>
        <button
          onClick={() => {
            toggleTranscript(sessionId)
            registry.focus(sessionId)
          }}
          title="Back to the live terminal"
          style={{
            marginLeft: 'auto',
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
        ) : (
          <div style={{ maxWidth: 900, margin: '0 auto' }}>
            {turns.map((turn) => (
              <TurnBlock key={turn.key} turn={turn} outputs={outputs} />
            ))}
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
  )
}
