import { useEffect } from 'react'
import { UI_BASE_FONT_SIZE, UI_BASE_ICON_SCALE } from '../shared/types'
import { buildGroups, useStore } from './state/store'
import * as registry from './term/registry'
import { Sidebar } from './components/Sidebar'
import { PaneGrid } from './components/PaneGrid'
import { Footer } from './components/Footer'
import { ConfirmDialog } from './components/ConfirmDialog'
import { NewSessionModal } from './components/NewSessionModal'
import { SettingsView } from './components/SettingsView'
import { NotesView } from './components/NotesView'
import { matchesAccelerator } from './shortcuts'
import { C } from './theme'

export function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  const setShowNew = useStore((s) => s.setShowNew)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const termFont = useStore((s) => s.settings?.terminalFont)
  const fontSize = useStore((s) => s.settings?.fontSize)
  const iconScale = useStore((s) => s.settings?.iconScale)
  const sidebarSide = useStore((s) => s.settings?.sidebarSide)

  useEffect(() => {
    void init()
  }, [init])

  // Terminal font family → xterm panes.
  useEffect(() => {
    if (termFont) registry.setFontFamily(termFont)
  }, [termFont])

  // Global UI size → zoom the whole interface (chrome + terminals).
  useEffect(() => {
    if (fontSize) {
      window.terminator.setZoom(fontSize / UI_BASE_FONT_SIZE)
      registry.refitVisible()
    }
  }, [fontSize])

  // Icon/button size → CSS variable consumed by Icon + button-box styles (via sz()).
  // Independent of the global zoom; multiplies on top of it. No terminal refit needed.
  useEffect(() => {
    const scale = (iconScale ?? UI_BASE_ICON_SCALE) / UI_BASE_ICON_SCALE
    document.documentElement.style.setProperty('--icon-scale', String(scale))
  }, [iconScale])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      // Don't hijack keys while typing in a terminal (let Ctrl+B/N reach the shell).
      const active = document.activeElement as HTMLElement | null
      if (active && active.closest('.xterm')) return
      const k = e.key.toLowerCase()
      if (k === 'n') {
        e.preventDefault()
        setShowNew(true)
      } else if (k === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setShowNew, toggleSidebar])

  // Alt+1..9 jumps to the Nth session in grouped order. Capture phase + stopPropagation
  // so it fires before xterm forwards Alt+digit to the PTY — i.e. it works even while a
  // terminal is focused. Reads fresh store state, so it never needs re-binding.
  useEffect(() => {
    const onAltDigit = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const m = /^Digit([1-9])$/.exec(e.code)
      if (!m) return
      const st = useStore.getState()
      if (st.showNew || st.showSettings) return // don't switch underneath a modal
      const list = buildGroups(st.order, st.sessions).flatMap((g) => g.sessions)
      const target = list[Number(m[1]) - 1]
      if (!target) return
      e.preventDefault()
      e.stopPropagation()
      st.openSession(target.id)
    }
    window.addEventListener('keydown', onAltDigit, true)
    return () => window.removeEventListener('keydown', onAltDigit, true)
  }, [])

  // Escape closes the topmost open modal. Bubble phase and only acts when a modal
  // is actually open, so a bare Esc still reaches terminals/vim untouched. The
  // Settings shortcut recorder stops propagation of its own keys (incl. Esc), so
  // recording never leaks here.
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const st = useStore.getState()
      // Close the highest-stacked modal by zIndex: Notes(60) > Confirm(55) > Settings/New(50).
      if (st.showNotes) st.setShowNotes(false)
      else if (st.confirm) st.setConfirm(null)
      else if (st.showSettings) st.setShowSettings(false)
      else if (st.showNew) st.setShowNew(false)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [])

  // Configurable accelerator toggles the Notes overlay. Capture phase + stopPropagation
  // (like Alt+digit) so it fires before xterm forwards the combo to the PTY — i.e. it
  // works even while a terminal is focused. Reads fresh store state, so no re-binding.
  useEffect(() => {
    const onNotesKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const accel = st.settings?.notesShortcut ?? ''
      if (!accel || !matchesAccelerator(e, accel)) return
      if (st.showNew || st.showSettings || st.confirm) return // don't toggle underneath another modal
      e.preventDefault()
      e.stopPropagation()
      st.setShowNotes(!st.showNotes)
    }
    window.addEventListener('keydown', onNotesKey, true)
    return () => window.removeEventListener('keydown', onNotesKey, true)
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100%',
        overflow: 'hidden',
        background: C.bg,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: sidebarSide === 'right' ? 'row-reverse' : 'row',
          flex: 1,
          minHeight: 0,
          width: '100%',
        }}
      >
        <Sidebar />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg }}>
          <PaneGrid />
        </div>
      </div>
      <Footer />
      <ConfirmDialog />
      <NewSessionModal />
      <SettingsView />
      <NotesView />
    </div>
  )
}
