import { C } from '../theme'

/**
 * The drag strip a glass window needs.
 *
 * Glass costs the window its OS frame (see main/glass.ts), and with it the title
 * bar that used to drag, double-click to maximise and carry the app's name. The
 * window buttons come back from Electron's titleBarOverlay, drawn by the system;
 * this is the rest of it. Rendered only in a glass mode — with glass off the app
 * has a real title bar and this doesn't exist.
 *
 * The env() values come from the overlay itself, so the strip stops exactly where
 * the system's buttons begin — on Windows that's the minimise/maximise/close
 * cluster on the right, on macOS the traffic lights on the left. The fallbacks
 * cover the moment before the overlay reports, and the platforms that never do.
 */
export function TitleBar(): React.JSX.Element {
  return (
    <div
      style={{
        // Transparent: the sidebar and pane column beneath paint the ground, and
        // a second layer here would compound their alpha.
        background: 'transparent',
        height: 'env(titlebar-area-height, 32px)',
        marginLeft: 'env(titlebar-area-x, 0px)',
        width: 'env(titlebar-area-width, 100%)',
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        fontSize: 11,
        color: C.faint,
        letterSpacing: 0.4,
        // The whole strip drags the window. Anything interactive added here has
        // to opt out with WebkitAppRegion: 'no-drag', or it won't take a click.
        WebkitAppRegion: 'drag',
        WebkitUserSelect: 'none',
      } as React.CSSProperties}
    >
      Terminator
    </div>
  )
}
