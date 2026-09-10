import type { SyntaxPalette, ThemePalette } from '../../shared/themes'

type Tok = keyof SyntaxPalette | 'plain'
type Line = [string, Tok][]

// A fixed snippet, tokenised by hand. Hand-tokenised rather than run through
// CodeMirror because this only has to *look* like code being highlighted, and a
// second live editor instance to colour twelve lines would be a lot of machinery
// for a swatch. The lines are real ones from this app, so the tokens that matter
// — a keyword, a call, a type, a template string, a comment — all show up.
const SAMPLE: Line[] = [
  [['// Paint a palette: every token becomes a CSS custom property.', 'comment']],
  [
    ['import', 'keyword'], [' { ', 'plain'], ['buildPalette', 'name'], [' } ', 'plain'],
    ['from', 'keyword'], [' ', 'plain'], ["'./themes'", 'string'],
  ],
  [],
  [['const', 'keyword'], [' ', 'plain'], ['RAMP_STEPS', 'constant'], [' = ', 'operator'], ['11', 'type']],
  [],
  [
    ['export', 'keyword'], [' ', 'plain'], ['function', 'keyword'], [' ', 'plain'], ['apply', 'func'],
    ['(', 'plain'], ['seed', 'def'], [': ', 'operator'], ['ThemeSeed', 'type'], ['): ', 'operator'],
    ['number', 'type'], [' {', 'plain'],
  ],
  [
    ['  ', 'plain'], ['const', 'keyword'], [' ', 'plain'], ['palette', 'def'], [' = ', 'operator'],
    ['buildPalette', 'func'], ['(', 'plain'], ['seed', 'name'], [')', 'plain'],
  ],
  [
    ['  ', 'plain'], ['if', 'keyword'], [' (', 'plain'], ['!', 'operator'], ['palette', 'name'],
    ['.', 'plain'], ['dark', 'name'], [') ', 'plain'], ['root', 'name'], ['.', 'plain'],
    ['scheme', 'name'], [' = ', 'operator'], ["'light'", 'string'],
  ],
  [
    ['  ', 'plain'], ['for', 'keyword'], [' (', 'plain'], ['const', 'keyword'], [' [', 'plain'],
    ['name', 'def'], [', ', 'plain'], ['value', 'def'], ['] ', 'plain'], ['of', 'keyword'], [' ', 'plain'],
    ['Object', 'type'], ['.', 'plain'], ['entries', 'func'], ['(', 'plain'], ['palette', 'name'], [')) {', 'plain'],
  ],
  [
    ['    ', 'plain'], ['root', 'name'], ['.', 'plain'], ['style', 'name'], ['.', 'plain'],
    ['setProperty', 'func'], ['(', 'plain'], ['`--c-${name}`', 'string'], [', ', 'plain'],
    ['value', 'name'], [')', 'plain'],
  ],
  [['  }', 'plain']],
  [['  ', 'plain'], ['return', 'keyword'], [' ', 'plain'], ['RAMP_STEPS', 'constant']],
  [['}', 'plain']],
]

/**
 * The syntax palette against something that reads like code. Painted from the
 * draft's *literal* values rather than the `--c-syn-*` variables, so it is right
 * even for a theme that isn't the one currently applied.
 */
export function ThemeCodeSample({ palette }: { palette: ThemePalette }): React.JSX.Element {
  return (
    <div
      style={{
        padding: '11px 13px',
        borderRadius: 9,
        background: palette.bg,
        border: `1px solid ${palette.panel2}`,
        fontSize: 11.5,
        lineHeight: 1.62,
        whiteSpace: 'pre',
        overflowX: 'auto',
        color: palette.text,
      }}
    >
      {SAMPLE.map((line, i) => (
        <div key={i} style={{ minHeight: '1.62em' }}>
          {line.map(([text, tok], j) => (
            <span key={j} style={tok === 'plain' ? undefined : { color: palette.syntax[tok] }}>
              {text}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
