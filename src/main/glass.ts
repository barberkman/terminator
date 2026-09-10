import { release } from 'node:os'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { ThemePalette } from '../shared/themes'
import type { GlassMode, GlassStatus } from '../shared/types'

/**
 * Window glass — letting the desktop show through the app's backgrounds.
 *
 * The whole reason this is a restart rather than a slider is in Electron's own
 * source. `NativeWindowViews::SetBackgroundMaterial` computes
 *
 *   is_translucent = backdrop != NONE && backdrop != AUTO && !has_frame()
 *
 * and only then extends the DWM frame across the client area. With an ordinary
 * OS frame, Mica and Acrylic reach the title bar and stop. `transparent: true`
 * says the same thing from the other side: on Windows it does nothing unless the
 * window is frameless. So glass means frameless, and frame is fixed at
 * construction — hence a relaunch.
 *
 * `has_frame_` is `frame && titleBarStyle === 'default'`, so `titleBarStyle:
 * 'hidden'` is enough to get there while `titleBarOverlay` keeps real, OS-drawn
 * minimise/maximise/close buttons. All the app has to supply is a drag strip.
 *
 * Nothing here ever calls `setIgnoreMouseEvents`, and the opacity floors in
 * shared/themes.ts keep every surface above zero alpha: a see-through area still
 * takes clicks and still takes focus.
 */

/** Mica and Acrylic are `DWMWA_SYSTEMBACKDROP_TYPE`, Windows 11 22H2 and up. */
const WIN11_22H2_BUILD = 22621

function windowsBuild(): number {
  // os.release() is the NT version on Windows, e.g. '10.0.22631'.
  return Number(release().split('.')[2]) || 0
}

/**
 * What the live window was actually built with. Set once by createWindow and
 * read back by Settings, which needs it to tell "you asked for acrylic" from
 * "this window is running acrylic" — the gap between the two is a restart.
 */
let active: GlassStatus = { requested: 'off', active: 'off' }

export function setActiveGlass(status: GlassStatus): void {
  active = status
}

export function glassStatus(): GlassStatus {
  return active
}

/**
 * What the requested mode comes out as here. Downgrades rather than failing: a
 * material Electron silently ignores would leave a frameless window with a
 * transparent web layer and no backdrop behind it, which renders black.
 */
export function resolveGlass(requested: GlassMode): GlassStatus {
  if (requested === 'off') return { requested, active: 'off' }

  if (process.platform === 'win32') {
    if (requested !== 'clear' && windowsBuild() < WIN11_22H2_BUILD) {
      return {
        requested,
        active: 'clear',
        reason: 'Acrylic and Mica need Windows 11 22H2 or newer — using plain transparency instead.',
      }
    }
    return { requested, active: requested }
  }

  if (process.platform === 'darwin') return { requested, active: requested }

  // Linux has no system backdrop; a material request becomes plain transparency,
  // which itself needs a compositing window manager to show anything.
  if (requested !== 'clear') {
    return {
      requested,
      active: 'clear',
      reason: 'Acrylic and Mica are Windows 11 only — using plain transparency instead.',
    }
  }
  return { requested, active: 'clear' }
}

/**
 * The BrowserWindow options for a resolved mode. `off` returns exactly what the
 * window has always been built with, down to the opaque themed `backgroundColor`
 * that stops a light theme flashing dark on the way in.
 */
export function glassWindowOptions(
  active: GlassMode,
  theme: ThemePalette,
): BrowserWindowConstructorOptions {
  if (active === 'off') {
    // The window paints this before the renderer's first frame, so it has to be
    // the chosen theme's background — otherwise a light theme opens with a dark
    // flash. Untouched by the glass work.
    return { backgroundColor: theme.bg }
  }

  const frameless: BrowserWindowConstructorOptions = {
    // Frameless (has_frame_ is `frame && titleBarStyle === 'default'`) while the
    // overlay keeps the system's own window buttons and publishes the
    // titlebar-area-* CSS env vars the drag strip lays itself out from.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: theme.footer, symbolColor: theme.text },
    // Cleared to nothing so the backdrop, not a colour, is what sits behind the
    // app's own translucent grounds. Electron copies this to the web layer too.
    backgroundColor: '#00000000',
  }

  if (process.platform === 'darwin') {
    // macOS has one blur to give and it isn't per-material, so every glass mode
    // lands on the same vibrancy. `active` keeps the window's blur while it's in
    // the background, which is what a supervisor window is usually doing.
    return { ...frameless, vibrancy: 'under-window', visualEffectState: 'active' }
  }

  if (active === 'clear') {
    // Plain see-through. Electron's documented costs: the window can't be
    // maximised from the title bar, and transparency drops while DevTools is
    // open. Clicks still land — transparent is not click-through.
    return { ...frameless, transparent: true }
  }

  return { ...frameless, backgroundMaterial: active }
}
