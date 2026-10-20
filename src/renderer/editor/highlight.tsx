import { useEffect, useMemo, useState } from 'react'
import type { LanguageDescription } from '@codemirror/language'
import { highlightCode } from '@lezer/highlight'
import { syntaxStyle } from './theme'

// Code highlighted outside an editor: a fenced block in a conversation or the
// Notes preview, an opened tool call. It's the editor's own parser and its own
// HighlightStyle run over the text once, so a file reads the same in a reply as
// it does in a tab — and since the style's colours are `var(--c-syn-*)`, a theme
// switch repaints these blocks with no re-render, the way it repaints an editor.

/** Past this, a block stays plain: a parse is synchronous and blocks the view. */
const MAX_CHARS = 200_000

// An editor mounts the style's rules itself; a code block has no editor to do it.
// The rules are plain class selectors, so one copy in <head> serves every block.
let mounted = false
function mountStyle(): void {
  if (mounted) return
  mounted = true
  const el = document.createElement('style')
  el.textContent = syntaxStyle.module?.getRules() ?? ''
  document.head.append(el)
}

/**
 * `text` as highlighted nodes for a `<code>`, or as the plain string until the
 * language's parser has loaded (each one is its own chunk, fetched on first use)
 * — or for good, when there's no language, the block is huge, or the parse fails.
 * The characters are the same either way; only spans are added around them.
 */
export function useHighlighted(text: string, lang: LanguageDescription | null | undefined): React.ReactNode {
  // `load()` sets `lang.support` itself; this only asks for the render that sees it.
  const [, setLoaded] = useState(0)
  useEffect(() => {
    if (!lang || lang.support) return
    let live = true
    lang.load().then(
      () => {
        if (live) setLoaded((n) => n + 1)
      },
      () => {
        // Couldn't load the parser: the block stays plain text.
      },
    )
    return () => {
      live = false
    }
  }, [lang])

  const support = lang?.support
  return useMemo(() => {
    if (!support || text.length > MAX_CHARS) return text
    try {
      const tree = support.language.parser.parse(text)
      mountStyle()
      const nodes: React.ReactNode[] = []
      highlightCode(
        text,
        tree,
        syntaxStyle,
        (s, cls) =>
          nodes.push(
            cls ? (
              <span key={nodes.length} className={cls}>
                {s}
              </span>
            ) : (
              s
            ),
          ),
        () => nodes.push('\n'),
      )
      return nodes
    } catch {
      return text
    }
  }, [text, support])
}
