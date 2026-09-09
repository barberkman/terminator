// The app's one markdown renderer: a small block/inline subset, rendered to React
// nodes, with a copy button on every fenced code block and click-to-copy on
// inline code. Shared by the Notes preview and the session conversation view —
// a second renderer would mean code blocks that copy differently depending on
// where you found them.
//
// Structural styling lives in styles.css under `.md-body` / `.md-pre` /
// `.md-inline-code`, so a caller only has to put `.md-body` on its container.

import { useState } from 'react'
import { C } from './theme'

/** A fenced code block rendered with a hover-revealed Copy button (top-right). */
export function CodeBlock({ text }: { text: string }): React.JSX.Element {
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

/** Minimal block-level markdown renderer covering the subset this app needs. */
export function renderMarkdown(src: string): React.ReactNode[] {
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
