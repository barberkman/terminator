import { useState } from 'react'
import { C, FONT } from '../theme'
import { Icon } from '../icons'

/** A fenced code block rendered with a hover-revealed Copy button (top-right). */
function CodeBlock({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    window.terminator.clipboardWrite(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="md-pre" style={{ position: 'relative' }}>
      <button
        className="md-copy"
        onClick={copy}
        style={{
          position: 'absolute',
          top: 7,
          right: 7,
          padding: '3px 9px',
          background: C.panel2,
          border: `1px solid ${C.border3}`,
          borderRadius: 6,
          color: copied ? C.accentSoft : C.muted,
          font: 'inherit',
          fontSize: 10.5,
          cursor: 'pointer',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}

// Matches the next inline token: `code`, **bold**/__bold__, *italic*/_italic_,
// ~~strike~~, or (image!)/[link](url). Order matters — code and bold are tried
// before italic so their markers aren't mistaken for single-emphasis markers.
const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(~~[^~]+~~)|(!?\[[^\]]*\]\([^)]+\))|(\*[^*]+\*|_[^_]+_)/

/** Render markdown inline spans (emphasis, code, links) to React nodes. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let rest = text
  let n = 0
  while (rest.length) {
    const m = INLINE_RE.exec(rest)
    if (!m) {
      nodes.push(rest)
      break
    }
    if (m.index > 0) nodes.push(rest.slice(0, m.index))
    const tok = m[0]
    const key = `${keyPrefix}-i${n++}`
    if (tok.startsWith('`')) {
      const inner = tok.slice(1, -1)
      nodes.push(
        <code
          key={key}
          className="md-inline-code"
          title="Click to copy"
          onClick={() => window.terminator.clipboardWrite(inner)}
        >
          {inner}
        </code>,
      )
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      nodes.push(<strong key={key}>{renderInline(tok.slice(2, -2), key)}</strong>)
    } else if (tok.startsWith('~~')) {
      nodes.push(<del key={key}>{renderInline(tok.slice(2, -2), key)}</del>)
    } else if (tok.startsWith('![')) {
      const mm = /!\[([^\]]*)\]\(([^)]+)\)/.exec(tok)!
      nodes.push(<img key={key} alt={mm[1]} src={mm[2]} />)
    } else if (tok.startsWith('[')) {
      const mm = /\[([^\]]*)\]\(([^)]+)\)/.exec(tok)!
      nodes.push(
        <a key={key} href={mm[2]} target="_blank" rel="noreferrer">
          {renderInline(mm[1], key)}
        </a>,
      )
    } else {
      nodes.push(<em key={key}>{renderInline(tok.slice(1, -1), key)}</em>)
    }
    rest = rest.slice(m.index + tok.length)
  }
  return nodes
}

const isBlockStart = (l: string): boolean =>
  /^```/.test(l) ||
  /^#{1,6}\s+/.test(l) ||
  /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l.trim()) ||
  /^>\s?/.test(l) ||
  /^\s*([-*+]|\d+\.)\s+/.test(l)

const splitTableRow = (l: string): string[] =>
  l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

/** Minimal block-level markdown renderer covering the subset the Notes editor uses. */
function renderMarkdown(src: string): React.ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let b = 0
  const key = () => `b${b++}`

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    // Fenced code block
    if (/^```/.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++ // closing fence
      blocks.push(<CodeBlock key={key()} text={buf.join('\n')} />)
      continue
    }

    // Heading (h1–h4; deeper levels clamp to h4 to match available styles)
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = Math.min(h[1].length, 4)
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4'
      const k = key()
      blocks.push(<Tag key={k}>{renderInline(h[2], k)}</Tag>)
      i++
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push(<hr key={key()} />)
      i++
      continue
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
      const k = key()
      blocks.push(<blockquote key={k}>{renderInline(buf.join(' '), k)}</blockquote>)
      continue
    }

    // GFM table (header row + |---|---| separator)
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      lines[i + 1].includes('-') &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])
    ) {
      const header = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitTableRow(lines[i++]))
      const k = key()
      blocks.push(
        <table key={k}>
          <thead>
            <tr>
              {header.map((c, ci) => (
                <th key={`${k}-h${ci}`}>{renderInline(c, `${k}-h${ci}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={`${k}-r${ri}`}>
                {r.map((c, ci) => (
                  <td key={`${k}-r${ri}c${ci}`}>{renderInline(c, `${k}-r${ri}c${ci}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }

    // List (unordered or ordered)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''))
      const k = key()
      const lis = items.map((it, idx) => <li key={`${k}-${idx}`}>{renderInline(it, `${k}-${idx}`)}</li>)
      blocks.push(ordered ? <ol key={k}>{lis}</ol> : <ul key={k}>{lis}</ul>)
      continue
    }

    // Paragraph (gather consecutive non-blank, non-block lines)
    const buf: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++])
    const k = key()
    blocks.push(<p key={k}>{renderInline(buf.join(' '), k)}</p>)
  }

  return blocks
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  resize: 'none',
  padding: '12px 14px',
  background: C.input,
  border: `1px solid ${C.border2}`,
  borderRadius: 8,
  color: C.textHi,
  fontFamily: FONT,
  fontSize: 12.5,
  lineHeight: 1.55,
  outline: 'none',
}

function ToggleButton({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px',
        borderRadius: 7,
        border: `1px solid ${on ? C.accentBorder : C.border2}`,
        background: on ? 'rgba(217,119,87,0.12)' : 'transparent',
        color: on ? C.accentSoft : C.muted,
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

export function NotesEditor({
  value,
  onChange,
  onSave,
  onClose,
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onClose: () => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'edit' | 'preview'>('preview')

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(10,9,8,0.66)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'cc-fade 0.18s ease',
      }}
    >
      <div
        style={{
          width: 760,
          maxWidth: '94vw',
          height: '82vh',
          display: 'flex',
          flexDirection: 'column',
          background: C.panel,
          border: `1px solid ${C.border3}`,
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '16px 20px 14px' }}>
          <span style={{ display: 'flex', color: C.accent }}>
            <Icon name="sparkle" size={16} />
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.textMax }}>Notes</span>
          <div style={{ display: 'flex', gap: 8, marginLeft: 14 }}>
            <ToggleButton on={mode === 'edit'} label="Edit" onClick={() => setMode('edit')} />
            <ToggleButton on={mode === 'preview'} label="Preview" onClick={() => setMode('preview')} />
          </div>
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', display: 'flex', width: 26, height: 26, alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer' }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, padding: '0 20px', overflow: 'hidden' }}>
          {mode === 'edit' ? (
            <textarea
              autoFocus
              spellCheck={false}
              placeholder="# Notes&#10;&#10;Write markdown here. Use `inline code` and fenced ``` blocks — they get copy buttons in Preview."
              style={textareaStyle}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <div className="md-body" style={{ height: '100%', overflowY: 'auto', padding: '0 4px 8px' }}>
              {value.trim() ? (
                renderMarkdown(value)
              ) : (
                <div style={{ color: C.dim, fontSize: 12.5, paddingTop: 8 }}>Nothing to preview yet.</div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '16px 20px 20px' }}>
          <button onClick={onClose} style={{ padding: '10px 18px', background: 'transparent', border: `1px solid ${C.border3}`, borderRadius: 9, color: '#b4afa3', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>
            Close
          </button>
          <button onClick={onSave} style={{ padding: '10px 20px', background: C.accent, border: 'none', borderRadius: 9, color: C.accentText, font: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
