// Keyboard-shortcut helpers shared between the Settings recorder (which encodes
// combos as Electron accelerator strings) and the renderer key handlers (which
// match those accelerators against DOM KeyboardEvents).

// Map a KeyboardEvent (via e.code, layout-independent) to an Electron accelerator token.
export function codeToAccel(code: string): string | null {
  let m
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1]
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1]
  if ((m = /^Numpad([0-9])$/.exec(code))) return 'num' + m[1]
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  const named: Record<string, string> = {
    Space: 'Space', Tab: 'Tab', Enter: 'Return', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  }
  return named[code] ?? null
}

export function eventToAccelerator(e: React.KeyboardEvent): string | null {
  const key = codeToAccel(e.code)
  if (!key) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.metaKey) mods.push('Super')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  return [...mods, key].join('+')
}

/**
 * Whether a DOM KeyboardEvent matches an Electron accelerator string. Empty
 * accelerator never matches (treated as disabled). Recognizes the tokens the
 * recorder emits (Control/Super/Alt/Shift) plus CmdOrCtrl / CommandOrControl,
 * which match either Ctrl or Meta so a cross-platform default works out of the box.
 */
export function matchesAccelerator(e: KeyboardEvent, accel: string): boolean {
  if (!accel) return false
  const parts = accel.split('+')
  const keyToken = parts[parts.length - 1]
  const key = codeToAccel(e.code)
  if (!key || key.toLowerCase() !== keyToken.toLowerCase()) return false

  const mods = parts.slice(0, -1).map((m) => m.toLowerCase())
  const wantCtrl = mods.includes('control') || mods.includes('ctrl')
  const wantMeta = mods.includes('super') || mods.includes('meta') || mods.includes('cmd') || mods.includes('command')
  const wantAlt = mods.includes('alt') || mods.includes('option')
  const wantShift = mods.includes('shift')
  const wantCmdOrCtrl = mods.includes('cmdorctrl') || mods.includes('commandorcontrol')

  if (wantCmdOrCtrl) {
    if (!(e.ctrlKey || e.metaKey)) return false
  } else {
    if (wantCtrl !== e.ctrlKey) return false
    if (wantMeta !== e.metaKey) return false
  }
  if (wantAlt !== e.altKey) return false
  if (wantShift !== e.shiftKey) return false
  return true
}
