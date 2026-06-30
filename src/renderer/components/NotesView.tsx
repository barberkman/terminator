import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
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
  const setSettings = useStore((s) => s.setSettings)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (show) setDraft(settings?.notes ?? '')
  }, [show, settings])

  if (!show) return null

  const save = async () => {
    const result = await window.terminator.updateSettings({ notes: draft })
    setSettings(result)
    setShow(false)
  }

  return (
    <NotesEditor
      value={draft}
      onChange={setDraft}
      onSave={() => void save()}
      onClose={() => setShow(false)}
    />
  )
}
