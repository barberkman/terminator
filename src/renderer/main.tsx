import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyThemeFromSettings } from './theme-apply'
import { setCustomThemes } from '../shared/themes'
import './styles.css'

// Paint the theme before the first frame. The window itself already opens on the
// theme's background (see main/index.ts), so the app never flashes the wrong
// palette on the way in — very visible when the chosen theme is a light one.
// The themes are fetched alongside the settings rather than after them: a custom
// theme that arrived a tick late would paint one frame of the default first,
// which is the exact flash the pre-render apply exists to avoid.
void Promise.all([window.terminator.getSettings(), window.terminator.getCustomThemes()]).then(
  ([settings, themes]) => {
    setCustomThemes(themes)
    applyThemeFromSettings(settings)
    createRoot(document.getElementById('root')!).render(<App />)
  },
)
