import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyThemeFromSettings } from './theme-apply'
import './styles.css'

// Paint the theme before the first frame. The window itself already opens on the
// theme's background (see main/index.ts), so the app never flashes the wrong
// palette on the way in — very visible when the chosen theme is a light one.
void window.terminator.getSettings().then((settings) => {
  applyThemeFromSettings(settings)
  createRoot(document.getElementById('root')!).render(<App />)
})
