// The app's one markdown renderer: a small block/inline subset, rendered to React
// nodes, with a copy button on every fenced code block and click-to-copy on
// inline code. Shared by the Notes preview and the session conversation view —
// a second renderer would mean code blocks that copy differently depending on
// where you found them.
//
// Structural styling lives in styles.css under `.md-body` / `.md-pre` /
// `.md-inline-code`, so a caller only has to put `.md-body` on its container.

import { useState } from 'react'
import { webUrl, webUrlRe } from '../shared/url'
import { C } from './theme'
import { openMenuForTarget, openWeb, trimUrl } from './term/links'

/**
 * A link in rendered markdown. Never a plain anchor.
 *
 * `target="_blank"` handed the URL to Electron's window-open path, and this text
 * came out of a transcript — that is, out of some program's output, which this app
 * has exactly one rule about. So the href goes through the same `webUrl` the main
 * process runs, and the click leaves by the same `openWeb` a URL clicked in a
 * terminal pane does: the same targets, the same configured default, the same
 * right-click menu, the same toast when nothing opens.
 *
 * No session is threaded in. `openWeb` falls back to the focused pane when it isn't
 * told one, and clicking a link in a conversation focuses that pane on the way —
 * so a browser pane still opens under the right project without every markdown
 * call site having to carry a session id it has no other use for.
 *
 * A URL that doesn't pass keeps its text and loses its link: the words are still
 * the author's, they just aren't a door.
 */
function MdLink({ href, children }: { href: string; children: React.ReactNode }): React.JSX.Element {
  const url = webUrl(href)
  if (!url) return <span title={href}>{children}</span>
  return (
    <a
      href={url}
      title={url}
      onClick={(e) => {
        e.preventDefault()
        void openWeb(url)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        openMenuForTarget(e.nativeEvent, { kind: 'web', url })
      }}
    >
      {children}
    </a>
  )
}

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
// ~~strike~~, (image!)/[link](url), or a bare URL. Order matters — code and bold
// are tried before italic so their markers aren't mistaken for single-emphasis
// markers, and the bare URL is last so `[text](url)` still wins over the URL
// inside it (alternation is leftmost-first, and the link starts earlier).
//
// The URL pattern is the one terminal output is scanned with. Claude prints bare
// URLs constantly, and the same text being a link in a pane and inert in that
// pane's own conversation is the confusing half of not doing this.
const INLINE_RE = new RegExp(
  '(`[^`]+`)' +
    '|(\\*\\*[^*]+\\*\\*|__[^_]+__)' +
    '|(~~[^~]+~~)' +
    '|(!?\\[[^\\]]*\\]\\([^)]+\\))' +
    '|(\\*[^*]+\\*|_[^_]+_)' +
    `|(${webUrlRe('').source})`,
)

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
    // Usually the whole token; a bare URL gives back the punctuation it swallowed.
    let consumed = tok.length
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
      nodes.push(<MdLink key={key} href={mm[2]}>{renderInline(mm[1], key)}</MdLink>)
    } else if (/^https?:\/\//.test(tok)) {
      // Trimmed the same way a terminal trims one, so "see https://x/y." and
      // "(https://x/y)" end a character early in both places. A link that behaves
      // differently depending on where you read it is worse than no link.
      const url = trimUrl(tok)
      // `consumed` drives the loop, so a zero-length one would spin forever and
      // take the window with it. trimUrl can't return '' today; this is here so
      // that stays true of the loop rather than of a function somewhere else.
      if (url) {
        consumed = url.length
        nodes.push(
          <MdLink key={key} href={url}>
            {url}
          </MdLink>,
        )
      } else {
        nodes.push(tok)
      }
    } else {
      nodes.push(<em key={key}>{renderInline(tok.slice(1, -1), key)}</em>)
    }
    rest = rest.slice(m.index + consumed)
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
