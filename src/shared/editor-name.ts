import type { EditorOption } from './types'

// What the editor button calls the program it opens. Shared because the same name
// is on the button's tooltip, in its right-click row, and in the toast main sends
// back when the launch fails — three places that would drift apart if each derived
// it on its own.

/** Executable basenames that aren't the name anyone calls the editor by. */
const FRIENDLY: Record<string, string> = {
  code: 'VS Code',
  'code-insiders': 'VS Code Insiders',
  codium: 'VSCodium',
  subl: 'Sublime Text',
  idea: 'IntelliJ IDEA',
}

/**
 * The editor's display name. `open -a <App>` (the macOS default) is named after
 * the app rather than `open`; anything else after its executable, without the
 * folder or the Windows extension.
 */
export function editorLabel(editor: EditorOption): string {
  const args = editor.args ?? []
  const base = editor.command.trim().split(/[/\\]/).filter(Boolean).pop() ?? ''
  if (base === 'open') {
    const app = args.indexOf('-a')
    if (app >= 0 && args[app + 1]) return args[app + 1].replace(/\.app$/i, '')
  }
  const name = base.replace(/\.(exe|cmd|bat|com)$/i, '')
  return FRIENDLY[name.toLowerCase()] ?? (name || 'your editor')
}
