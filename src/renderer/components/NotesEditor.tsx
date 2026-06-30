import { useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { C, FONT } from '../theme'
import { Icon } from '../icons'

/** Recursively collect text from a hast node (used to grab a code block's raw source). */
function hastText(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] } | null
  if (!n) return ''
  if (n.type === 'text') return n.value ?? ''
  if (Array.isArray(n.children)) return n.children.map(hastText).join('')
  return ''
}

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

const mdComponents: Components = {
  // Render the block ourselves (from the hast node's text) so the copy button has the
  // raw source and inline `code` below only ever fires for inline spans.
  pre({ node }) {
    return <CodeBlock text={hastText(node).replace(/\n$/, '')} />
  },
  // Inline code: click to copy.
  code({ children }) {
    const text = String(children)
    return (
      <code
        className="md-inline-code"
        title="Click to copy"
        onClick={() => window.terminator.clipboardWrite(text)}
      >
        {children}
      </code>
    )
  },
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
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {value}
                </ReactMarkdown>
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
