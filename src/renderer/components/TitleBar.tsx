import { useEffect, useState } from 'react'
import { TITLE_BAR_HEIGHT, UI_BASE_FONT_SIZE } from '../../shared/types'
import { C } from '../theme'
import { useStore } from '../state/store'

/** Not in React's CSS types: marks the strip as the window's drag handle. */
const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties

/**
 * The window's title bar on Windows, where the native one can't take a theme's
 * colours. Main hides the OS frame and leaves only the caption buttons, laid over
 * the right-hand end of this strip and recoloured by applyTheme(); everything
 * else — the fill, the hairline, the title — is drawn here, in the sidebar's
 * colour, the way VS Code draws its own. Nothing in it is clickable, so the whole
 * strip drags, double-click maximises and it snaps like any title bar.
 *
 * The caption buttons are sized in window pixels and ignore the UI zoom, so the
 * strip divides the zoom back out to stay exactly as tall as they are.
 */
export function TitleBar(): React.JSX.Element {
  const fontSize = useStore((s) => s.settings?.fontSize ?? UI_BASE_FONT_SIZE)
  const [focused, setFocused] = useState(() => document.hasFocus())

  useEffect(() => {
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  return (
    <div
      style={{
        ...drag,
        flex: 'none',
        height: (TITLE_BAR_HEIGHT * UI_BASE_FONT_SIZE) / fontSize,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: C.sidebar,
        // Below the buttons' height, not inside it: they paint their own backing
        // over the strip, and would hide the right-hand end of the hairline.
        borderBottom: `1px solid ${C.border}`,
        boxSizing: 'content-box',
        fontSize: 12,
        // Dims with the window, as VS Code's title does.
        color: focused ? C.text : C.muted,
        userSelect: 'none',
      }}
    >
      Terminator
    </div>
  )
}
