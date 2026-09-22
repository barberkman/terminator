// Claude's Ctrl+G, landing in an Editor pane.
//
// The main process is holding that session blocked for as long as the tab is open
// (main/prompt-edit.ts), so this side has exactly one rule: **every way out reports
// back**. The button, the ✕, a pane or session disposed under it, and every failure
// on the way in. A path that forgets leaves a Claude session on a blank alternate
// screen with nothing to press.
//
// The tab is an ordinary editor tab — same CodeMirror, same Ctrl+S, same markdown
// highlighting, because Claude's prompt file is a `.md`. What makes it different is
// the banner (components/EditorPaneBody.tsx), which is the only thing on screen that
// knows a session is waiting on it.

import { create } from 'zustand'
import type { PromptEdit } from '../shared/types'
import * as editors from './editor/registry'
import { useStore } from './state/store'
import { ensureEditorPane } from './term/links'

export interface LiveEdit extends PromptEdit {
  /** The Editor session whose tab is holding it. */
  editorSessionId: string
}

interface PromptEditState {
  /** Keyed by absolute file — the same identity main and the tab both use. */
  edits: Record<string, LiveEdit>
  add(e: LiveEdit): void
  drop(file: string): void
}

export const usePromptEdits = create<PromptEditState>((set) => ({
  edits: {},
  add(e) {
    set((s) => ({ edits: { ...s.edits, [e.file]: e } }))
  },
  drop(file) {
    set((s) => {
      if (!s.edits[file]) return {}
      const edits = { ...s.edits }
      delete edits[file]
      return { edits }
    })
  },
}))

/**
 * Claude's own temp file is `claude-prompt-<hex>.md`, which is nobody's idea of a
 * tab title. Anything else that reached us through `$VISUAL` — a commit message,
 * say — is a real file the user knows by name, so it keeps it.
 */
function tabName(e: PromptEdit): string {
  const base = e.file.split(/[/\\]/).filter(Boolean).pop() || e.file
  return /^claude-prompt-[0-9a-f]+\.md$/i.test(base) ? `Prompt — ${e.sessionName}` : base
}

/**
 * Let the session carry on. Idempotent, and deliberately the only place that tells
 * main an edit is over — every other path in this file goes through it.
 */
export function finishEdit(file: string): void {
  if (!usePromptEdits.getState().edits[file]) return
  usePromptEdits.getState().drop(file)
  window.terminator.promptEditDone(file)
}

/**
 * Hand the prompt back: save what's in the tab, close it, release the session.
 *
 * The order is load-bearing. Closing the tab is what reports back, and reporting
 * back is what makes main drop its grant on a file that lives outside every
 * session's folder — so a save after either of those would be refused.
 */
export async function sendBack(file: string): Promise<void> {
  const e = usePromptEdits.getState().edits[file]
  if (!e) return
  await editors.saveTab(e.editorSessionId, file)
  // closeTab fires the gone-hook set in `open`, which is what calls finishEdit.
  editors.closeTab(e.editorSessionId, file)
}

/** A session pressed Ctrl+G: put its prompt in a tab. */
async function open(e: PromptEdit): Promise<void> {
  const pane = await ensureEditorPane(e.sessionId)
  if (!pane) {
    // ensureEditorPane has already said why. Don't also leave the session waiting.
    window.terminator.promptEditDone(e.file)
    return
  }
  // Recorded before the open so the gone-hook below has something to find, whichever
  // way the open turns out.
  usePromptEdits.getState().add({ ...e, editorSessionId: pane.id })
  await editors.openFile(pane.id, e.file, tabName(e), {
    watch: false,
    onGone: () => finishEdit(e.file),
  })
  if (!editors.hasView(pane.id, e.file)) {
    // Unreadable — gone, binary, too large. The tab can say so, but there is nothing
    // to edit, so close it rather than make the session wait for an answer that
    // isn't coming.
    editors.closeTab(pane.id, e.file)
    return
  }
  // Only now: this stops main's "did a tab ever appear" backstop, and from here the
  // edit lasts exactly as long as the typing does.
  window.terminator.promptEditOpened(e.file)
  editors.focusTab(pane.id, e.file)
}

/**
 * The session stopped waiting, and not because of anything done here: Ctrl+C in the
 * pane, the session stopped, a second Ctrl+G superseding this one.
 *
 * The tab has to go. Main has taken back the one permission that let the editor
 * touch a file outside any project, so what is left is a tab you can type in and
 * cannot save — a worse thing to leave behind than a closed one. The toast is there
 * because the tab vanishing is otherwise unexplained.
 */
function ended(file: string): void {
  const e = usePromptEdits.getState().edits[file]
  if (!e) return // this side is what ended it; nothing to undo
  usePromptEdits.getState().drop(file)
  editors.closeTab(e.editorSessionId, file)
  useStore.getState().pushToast({
    tone: 'error',
    icon: 'editor',
    text: `${e.sessionName} stopped waiting for that prompt`,
    sub: 'Nothing was sent, and the prompt is as it was. The tab is closed.',
  })
}

/** Subscribe to Ctrl+G hand-offs for the life of the app. */
export function wirePromptEdits(): () => void {
  const offOpen = window.terminator.onPromptEdit((e) => void open(e))
  const offEnded = window.terminator.onPromptEditEnded(ended)
  return () => {
    offOpen()
    offEnded()
  }
}
