import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

// Every language CodeMirror ships a mode for, each loaded on first use: the
// descriptions are only names and filename patterns, and `load()` pulls the
// parser in as its own chunk. Markdown is the one swapped out — the stock entry
// is plain CommonMark, and this one is GitHub's flavour with fenced code
// highlighted in its own language, which is most of what a Claude prompt is.
const markdown = LanguageDescription.of({
  name: 'Markdown',
  extensions: ['md', 'markdown', 'mkd'],
  load: () =>
    import('@codemirror/lang-markdown').then((m) =>
      m.markdown({ base: m.markdownLanguage, codeLanguages: languages }),
    ),
})

const ALL = languages.map((d) => (d.name === 'Markdown' ? markdown : d))

/** Dotfiles with no extension to go by, mapped to a language name in `ALL`. */
const DOTFILES: Record<string, string> = {
  '.bashrc': 'Shell',
  '.bash_profile': 'Shell',
  '.zshrc': 'Shell',
  '.zprofile': 'Shell',
  '.profile': 'Shell',
  '.env': 'Properties files',
}

/**
 * Map a filename to a CodeMirror language, or null for plain text (which still
 * gets line numbers, a gutter, and undo). The language may not be loaded yet:
 * `support` is set once it is, and `load()` fetches it.
 */
export function languageFor(path: string): LanguageDescription | null {
  const name = path.split(/[/\\]/).pop() ?? path
  const dotfile = DOTFILES[name.toLowerCase()]
  return (
    LanguageDescription.matchFilename(ALL, name) ??
    // Extensions are matched case-sensitively; `README.MD` is still markdown.
    LanguageDescription.matchFilename(ALL, name.toLowerCase()) ??
    (dotfile ? LanguageDescription.matchLanguageName(ALL, dotfile) : null)
  )
}

/**
 * Fence tags that say "no language". Only `text` would otherwise match anything
 * — it's one of LaTeX's extensions — but it's the one Claude writes most.
 */
const PLAIN_TAGS = new Set(['text', 'txt', 'plain', 'plaintext'])

/**
 * Map what a code block says it's written in to a language: a fence's tag
 * (`cpp`, `bash`, `py`) or the path of the file the code belongs to (a tool
 * call's edit). Tried as a language name or alias first, then as a filename,
 * then as a bare extension — `py` and `rs` are nobody's name for anything.
 */
export function languageForTag(tag: string): LanguageDescription | null {
  if (PLAIN_TAGS.has(tag.toLowerCase())) return null
  return (
    LanguageDescription.matchLanguageName(ALL, tag, false) ??
    languageFor(tag) ??
    languageFor(`x.${tag}`)
  )
}
