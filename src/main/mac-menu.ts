import { app, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * The macOS menu bar. Not Electron's default, which is a browser's: its Reload
 * (Cmd+R) would throw away every terminal's scrollback while the sessions behind
 * them keep running, its zoom items (Cmd+0/+/−) fight Settings' font size, and its
 * Close Window (Cmd+W) used to leave panes with nothing feeding them.
 *
 * What stays is what macOS needs a menu for. The Edit menu carries Cmd+C/V/X/Z/A
 * to text fields, the editor and web pages — on macOS those keys work only
 * through it. The app and Window menus give Hide, Quit, Minimize and Close their
 * usual places; Close hides the window (see index.ts). Every shortcut the app
 * defines itself is still handled in the renderer, as on the other platforms.
 */
export function macMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        // A development build keeps the developer tools; a packaged one has no use for them.
        ...(app.isPackaged ? [] : [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }]),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}
