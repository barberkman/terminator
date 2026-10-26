import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { saveSettings } from '../settingsActions'
import { NotesEditor } from './NotesEditor'

/**
 * Standalone overlay for the markdown note, opened in one click from the sidebar
 * header. Self-gates on `showNotes` (mirrors SettingsView). Keeps a local draft so
 * Close discards unsaved edits; Save persists just `notes` through the merging
 * settings pipeline (saveSettings deep-merges the patch).
 */
export function NotesView(): React.JSX.Element | null {
  const show = useStore((s) => s.showNotes)
  const setShow = useStore((s) => s.setShowNotes)
  const settings = useStore((s) => s.settings)
  const [draft, setDraft] = useState('')
  // What the draft was taken from. While the two match there are no edits to lose,
  // so notes that change on disk — a `git pull` in the sync folder — come straight in.
  const seeded = useRef<string | null>(null)

  useEffect(() => {
    if (!show) {
      seeded.current = null
      return
    }
    const stored = settings?.notes ?? ''
    if (seeded.current === null || draft === seeded.current) {
      setDraft(stored)
      seeded.current = stored
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, settings])

  if (!show) return null

  const stored = settings?.notes ?? ''
  const changedUnderneath = seeded.current !== null && stored !== seeded.current

  const save = async () => {
    if (await saveSettings({ notes: draft })) setShow(false)
  }

  return (
    <NotesEditor
      value={draft}
      onChange={setDraft}
      onSave={() => void save()}
      onClose={() => setShow(false)}
      notice={changedUnderneath ? 'These notes changed on disk since you opened them. Save replaces that version with yours.' : undefined}
    />
  )
}
