import { useEffect } from 'react'
import { UI_BASE_FONT_SIZE } from '../shared/types'
import { useStore } from './state/store'
import * as registry from './term/registry'
import { Sidebar } from './components/Sidebar'
import { PaneGrid } from './components/PaneGrid'
import { Footer } from './components/Footer'
import { ConfirmDialog } from './components/ConfirmDialog'
import { NewSessionModal } from './components/NewSessionModal'
import { SettingsView } from './components/SettingsView'
import { C } from './theme'

export function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  const setShowNew = useStore((s) => s.setShowNew)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const termFont = useStore((s) => s.settings?.terminalFont)
  const fontSize = useStore((s) => s.settings?.fontSize)

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
      <div style={{ display: 'flex', flex: 1, minHeight: 0, width: '100%' }}>
        <Sidebar />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg }}>
          <PaneGrid />
        </div>
      </div>
      <Footer />
      <ConfirmDialog />
      <NewSessionModal />
      <SettingsView />
    </div>
  )
}
