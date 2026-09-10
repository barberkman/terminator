import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyThemeFromSettings } from './theme-apply'
import { setCustomThemes } from '../shared/themes'
import './styles.css'

// Ahead of everything: the palette main resolved at construction, handed over
// through preload rather than fetched. With glass off the window's own
// backgroundColor already covers this moment; with glass on it can't — the
// window has to be cleared to nothing for the desktop to come through — so this
// is what keeps the first painted frame the right colour either way. A null
// bootTheme (an older build, a malformed argument) falls back to the static
// :root palette in styles.css, exactly as before.
const boot = window.terminator.bootTheme
if (boot) {
  const root = document.documentElement
  for (const [name, value] of Object.entries(boot.vars)) root.style.setProperty(name, value)
  root.style.colorScheme = boot.dark ? 'dark' : 'light'
  root.dataset.theme = boot.id
}
if (boot?.glass && boot.glass !== 'off') document.documentElement.dataset.glass = boot.glass

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
