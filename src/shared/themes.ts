import type { SessionStatus } from './types'

// ---- Theme model -----------------------------------------------------------
//
// A theme is authored as a compact *seed*: a background, a two-anchor text
// colour pair, a handful of accents, and the terminal/editor palettes. Everything
// else — the six surface shades and the eleven-step text ramp — is derived, so a
// new theme is ~25 lines of data rather than forty hand-picked colours.
//
// The built palette is consumed twice over: as CSS custom properties (which is
// how the ~350 inline `style={{}}` sites in the renderer read colours, via the
// `C` tokens in renderer/theme.ts) and as literal values (xterm parses colours in
// JS for its renderer and cannot take a `var()`).

export type ThemeGroup = 'dark' | 'light' | 'reading'

/** The 16 ANSI slots xterm paints program output with. */
export interface AnsiPalette {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** Token colours for the CodeMirror editor's syntax highlighting. */
export interface SyntaxPalette {
  keyword: string
  name: string
  func: string
  constant: string
  def: string
  type: string
  operator: string
  comment: string
  string: string
  invalid: string
}

/** The eleven text shades, brightest first. */
export type RampKey =
  | 'textMax'
  | 'textHi'
  | 'textStrong'
  | 'text'
  | 'textBtn'
  | 'body'
  | 'textSubtle'
  | 'muted'
  | 'dim'
  | 'faint'
  | 'faint2'

type Surfaces = { sidebar: string; footer: string; panel: string; panel2: string; input: string }

export interface ThemeSeed {
  id: string
  name: string
  group: ThemeGroup
  /** Drives CodeMirror's `dark` flag and the window's `color-scheme`. */
  dark: boolean
  /** The base background everything else is shaded from. */
  bg: string
  /**
   * How far the raised surfaces (sidebar, panels, footer) sit from `bg`, in
   * 0-255 units. Positive lightens — right for dark themes and for light themes
   * whose panels are white cards; negative darkens the chrome away from a white
   * page, which is what the reading presets want.
   */
  elev: number
  /** Any surface can be pinned instead of derived. */
  surfaces?: Partial<Surfaces>
  /** Brightest text (headings); the top of the ramp. */
  hi: string
  /** Body text; the ramp's `text` step, and the source of every hairline tint. */
  fg: string
  /** Overrides for individual ramp steps. */
  ramp?: Partial<Record<RampKey, string>>
  accent: string
  accentSoft: string
  /** Text drawn *on* the accent (primary buttons). */
  accentText: string
  danger: string
  /** The neutral blue-grey of the session-kind icons. */
  kindIcon: string
  /** Base for modal scrims and drop shadows. */
  shadow: string
  status: Record<SessionStatus, string>
  ansi: AnsiPalette
  syntax: SyntaxPalette
  /** App-chrome font weight. The `bold` reading preset uses 600. */
  uiWeight?: 400 | 500 | 600
  /** Optional CSS background-image layer painted behind the chrome. */
  texture?: string
}

export interface ThemePalette extends Record<RampKey, string> {
  id: string
  name: string
  group: ThemeGroup
  dark: boolean
  bg: string
  sidebar: string
  footer: string
  panel: string
  panel2: string
  input: string
  accent: string
  accentSoft: string
  accentText: string
  danger: string
  kindIcon: string
  /** "r,g,b" triplets — every alpha tint in the app is mixed from one of these. */
  bgRgb: string
  inkRgb: string
  accentRgb: string
  dangerRgb: string
  shadowRgb: string
  status: Record<SessionStatus, string>
  ansi: AnsiPalette
  syntax: SyntaxPalette
  uiWeight: number
  texture: string
}

// ---- colour helpers --------------------------------------------------------

function parse(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
const hex2 = (n: number): string => clamp(n).toString(16).padStart(2, '0')

function toHex([r, g, b]: [number, number, number]): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

/** `t` of the way from `a` to `b`. */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parse(a)
  const [br, bg, bb] = parse(b)
  return toHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t])
}

/** Shift every channel by `n` (clamped). */
function shade(color: string, n: number): string {
  const [r, g, b] = parse(color)
  return toHex([r + n, g + n, b + n])
}

/** "r,g,b" — the form `rgba(var(--c-ink-rgb), 0.07)` needs. */
export function rgbTriplet(hex: string): string {
  return parse(hex).join(',')
}

// The ramp's stops. The bright half interpolates `hi` → `fg`; the dim half
// fades `fg` into the background. These specific stops were chosen to reproduce
// the original Terminator ramp (which is pinned literally below anyway) so every
// other theme inherits its proportions.
const BRIGHT_STOPS: Partial<Record<RampKey, number>> = {
  textHi: 0.3,
  textStrong: 0.72,
}
const DIM_STOPS: Partial<Record<RampKey, number>> = {
  textBtn: 0.12,
  body: 0.21,
  textSubtle: 0.29,
  muted: 0.44,
  dim: 0.53,
  faint: 0.63,
  faint2: 0.73,
}

function buildRamp(seed: ThemeSeed): Record<RampKey, string> {
  const out = { textMax: seed.hi, text: seed.fg } as Record<RampKey, string>
  // Fading ink into a light page loses perceived contrast faster than fading it
  // into a dark one, so the dim half is pulled in on light themes — otherwise
  // labels like `muted` end up too pale to read.
  const k = seed.dark ? 1 : 0.78
  for (const [key, t] of Object.entries(BRIGHT_STOPS)) out[key as RampKey] = mix(seed.hi, seed.fg, t)
  for (const [key, t] of Object.entries(DIM_STOPS)) out[key as RampKey] = mix(seed.fg, seed.bg, t * k)
  return { ...out, ...seed.ramp }
}

function buildSurfaces(seed: ThemeSeed): Surfaces {
  const e = seed.elev
  return {
    sidebar: shade(seed.bg, e * 1.2),
    footer: shade(seed.bg, e * 0.6),
    panel: shade(seed.bg, e * 1.4),
    panel2: shade(seed.bg, e * 2),
    input: shade(seed.bg, e * -0.2),
    ...seed.surfaces,
  }
}

export function buildPalette(seed: ThemeSeed): ThemePalette {
  return {
    id: seed.id,
    name: seed.name,
    group: seed.group,
    dark: seed.dark,
    bg: seed.bg,
    ...buildSurfaces(seed),
    ...buildRamp(seed),
    accent: seed.accent,
    accentSoft: seed.accentSoft,
    accentText: seed.accentText,
    danger: seed.danger,
    kindIcon: seed.kindIcon,
    bgRgb: rgbTriplet(seed.bg),
    inkRgb: rgbTriplet(seed.fg),
    accentRgb: rgbTriplet(seed.accent),
    dangerRgb: rgbTriplet(seed.danger),
    shadowRgb: rgbTriplet(seed.shadow),
    status: seed.status,
    ansi: seed.ansi,
    syntax: seed.syntax,
    uiWeight: seed.uiWeight ?? 400,
    texture: seed.texture ?? 'none',
  }
}

// ---- shared palettes -------------------------------------------------------

/** xterm's own defaults — what Terminator's panes have always painted with. */
const ANSI_DEFAULT: AnsiPalette = {
  black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
  blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
  brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f',
  brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
}

/** Darkened ANSI for light grounds — the standard set is unreadable on cream. */
const ANSI_LIGHT: AnsiPalette = {
  black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700',
  blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#7d4e00',
  brightBlue: '#0550ae', brightMagenta: '#6639ba', brightCyan: '#1b7c83', brightWhite: '#24292f',
}

/** Warmer still, for the sepia reading presets. */
const ANSI_SEPIA: AnsiPalette = {
  black: '#3a342a', red: '#9c3b2e', green: '#4f7a3f', yellow: '#8a6a1f',
  blue: '#3f6280', magenta: '#7a4a72', cyan: '#2f7370', white: '#6d6455',
  brightBlack: '#57503f', brightRed: '#7d2b20', brightGreen: '#3d6130', brightYellow: '#6d5314',
  brightBlue: '#2f4c66', brightMagenta: '#5f3859', brightCyan: '#245b58', brightWhite: '#33302a',
}

const SYNTAX_ONE_DARK: SyntaxPalette = {
  keyword: '#c678dd', name: '#e06c75', func: '#61afef', constant: '#d19a66',
  def: '#abb2bf', type: '#e5c07b', operator: '#56b6c2', comment: '#7d8799',
  string: '#98c379', invalid: '#ffffff',
}

const SYNTAX_DARCULA: SyntaxPalette = {
  keyword: '#cc7832', name: '#a9b7c6', func: '#ffc66d', constant: '#9876aa',
  def: '#a9b7c6', type: '#6897bb', operator: '#a9b7c6', comment: '#808080',
  string: '#6a8759', invalid: '#ff6b68',
}

const SYNTAX_DRACULA: SyntaxPalette = {
  keyword: '#ff79c6', name: '#f8f8f2', func: '#50fa7b', constant: '#bd93f9',
  def: '#f8f8f2', type: '#8be9fd', operator: '#ff79c6', comment: '#6272a4',
  string: '#f1fa8c', invalid: '#ff5555',
}

const SYNTAX_GRUVBOX: SyntaxPalette = {
  keyword: '#fb4934', name: '#ebdbb2', func: '#b8bb26', constant: '#d3869b',
  def: '#ebdbb2', type: '#fabd2f', operator: '#8ec07c', comment: '#928374',
  string: '#b8bb26', invalid: '#fb4934',
}

const SYNTAX_NORD: SyntaxPalette = {
  keyword: '#81a1c1', name: '#d8dee9', func: '#88c0d0', constant: '#b48ead',
  def: '#d8dee9', type: '#8fbcbb', operator: '#81a1c1', comment: '#616e88',
  string: '#a3be8c', invalid: '#bf616a',
}

/** Solarized's accents are ground-agnostic, so dark and light share them. */
const SYNTAX_SOLARIZED: SyntaxPalette = {
  keyword: '#859900', name: '#268bd2', func: '#268bd2', constant: '#cb4b16',
  def: '#657b83', type: '#b58900', operator: '#859900', comment: '#93a1a1',
  string: '#2aa198', invalid: '#dc322f',
}

const SYNTAX_LIGHT: SyntaxPalette = {
  keyword: '#cf222e', name: '#0550ae', func: '#8250df', constant: '#0550ae',
  def: '#24292f', type: '#953800', operator: '#0550ae', comment: '#6e7781',
  string: '#0a3069', invalid: '#cf222e',
}

const SYNTAX_SEPIA: SyntaxPalette = {
  keyword: '#9c3b2e', name: '#3f6280', func: '#7a4a72', constant: '#8a5a2b',
  def: '#33302a', type: '#8a6a1f', operator: '#4f7a3f', comment: '#8a8171',
  string: '#4f7a3f', invalid: '#9c3b2e',
}

/**
 * Moon+ Reader's paper grain: two barely-there gradients — fine vertical fibres
 * plus a broad diagonal wash — so the cream ground reads as a page rather than a
 * flat fill. Only ever painted behind the app chrome; the terminal and editor
 * panes draw their own opaque background over it, so glyph rendering is
 * untouched.
 */
const PAPER_TEXTURE =
  'repeating-linear-gradient(90deg, rgba(120,100,70,0.035) 0 1px, transparent 1px 3px),' +
  'linear-gradient(160deg, rgba(150,130,95,0.07), rgba(255,250,235,0.05) 55%, rgba(140,120,85,0.06))'

// ---- the themes ------------------------------------------------------------

export const THEME_SEEDS: ThemeSeed[] = [
  {
    id: 'terminator',
    name: 'Terminator',
    group: 'dark',
    dark: true,
    bg: '#1a1917',
    elev: 5,
    surfaces: { sidebar: '#201e1b', footer: '#1d1c19', panel: '#211f1c', panel2: '#242220', input: '#191815' },
    hi: '#f0ece2',
    fg: '#cbc6b8',
    // Pinned to the original design's values so the default theme is unchanged
    // by the switch to a derived ramp.
    ramp: {
      textHi: '#e8e4d9', textStrong: '#d6d1c4', textBtn: '#b4afa3', body: '#a8a397',
      textSubtle: '#9a958a', muted: '#807b6f', dim: '#6e6a60', faint: '#5e594f', faint2: '#4d4940',
    },
    accent: '#d97757',
    accentSoft: '#e3ad96',
    accentText: '#1a120c',
    danger: '#cf5e4e',
    kindIcon: '#7d8597',
    shadow: '#0a0908',
    status: { busy: '#7a9bbf', waiting: '#d97757', idle: '#80a86f', error: '#cf5e4e', closed: '#6e6a60' },
    ansi: ANSI_DEFAULT,
    syntax: SYNTAX_ONE_DARK,
  },
  {
    id: 'darcula',
    name: 'Darcula',
    group: 'dark',
    dark: true,
    bg: '#2b2b2b',
    elev: 9,
    surfaces: { panel: '#3c3f41', panel2: '#4e5254' },
    hi: '#e6ebf2',
    fg: '#a9b7c6',
    accent: '#cc7832',
    accentSoft: '#e0a35f',
    accentText: '#1f1500',
    danger: '#ff6b68',
    kindIcon: '#6897bb',
    shadow: '#000000',
    status: { busy: '#6897bb', waiting: '#cc7832', idle: '#6a8759', error: '#ff6b68', closed: '#808080' },
    ansi: {
      black: '#000000', red: '#ff6b68', green: '#a8c023', yellow: '#d6bf55',
      blue: '#5394ec', magenta: '#ae8abe', cyan: '#299999', white: '#999999',
      brightBlack: '#555555', brightRed: '#ff8785', brightGreen: '#a8c023', brightYellow: '#ffff00',
      brightBlue: '#7eaef1', brightMagenta: '#ff99ff', brightCyan: '#6cdada', brightWhite: '#ffffff',
    },
    syntax: SYNTAX_DARCULA,
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    group: 'dark',
    dark: true,
    bg: '#282c34',
    elev: 8,
    hi: '#eef1f6',
    fg: '#abb2bf',
    accent: '#61afef',
    accentSoft: '#8fc7f3',
    accentText: '#06121f',
    danger: '#e06c75',
    kindIcon: '#c678dd',
    shadow: '#000000',
    status: { busy: '#61afef', waiting: '#d19a66', idle: '#98c379', error: '#e06c75', closed: '#5c6370' },
    ansi: {
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
    syntax: SYNTAX_ONE_DARK,
  },
  {
    id: 'dracula',
    name: 'Dracula',
    group: 'dark',
    dark: true,
    bg: '#282a36',
    elev: 9,
    hi: '#ffffff',
    fg: '#f8f8f2',
    accent: '#bd93f9',
    accentSoft: '#d6b9ff',
    accentText: '#1a0f2b',
    danger: '#ff5555',
    kindIcon: '#8be9fd',
    shadow: '#000000',
    status: { busy: '#8be9fd', waiting: '#ffb86c', idle: '#50fa7b', error: '#ff5555', closed: '#6272a4' },
    ansi: {
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
    syntax: SYNTAX_DRACULA,
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    group: 'dark',
    dark: true,
    bg: '#282828',
    elev: 9,
    hi: '#fbf1c7',
    fg: '#ebdbb2',
    accent: '#fe8019',
    accentSoft: '#fabd2f',
    accentText: '#1d2021',
    danger: '#fb4934',
    kindIcon: '#83a598',
    shadow: '#000000',
    status: { busy: '#83a598', waiting: '#fe8019', idle: '#b8bb26', error: '#fb4934', closed: '#928374' },
    ansi: {
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
    syntax: SYNTAX_GRUVBOX,
  },
  {
    id: 'nord',
    name: 'Nord',
    group: 'dark',
    dark: true,
    bg: '#2e3440',
    elev: 8,
    hi: '#eceff4',
    fg: '#d8dee9',
    accent: '#88c0d0',
    accentSoft: '#8fbcbb',
    accentText: '#10161c',
    danger: '#bf616a',
    kindIcon: '#81a1c1',
    shadow: '#0b0e14',
    status: { busy: '#81a1c1', waiting: '#ebcb8b', idle: '#a3be8c', error: '#bf616a', closed: '#4c566a' },
    ansi: {
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
    syntax: SYNTAX_NORD,
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    group: 'dark',
    dark: true,
    bg: '#002b36',
    elev: 9,
    hi: '#eee8d5',
    fg: '#93a1a1',
    accent: '#268bd2',
    accentSoft: '#6cb3e8',
    accentText: '#00212b',
    danger: '#dc322f',
    kindIcon: '#2aa198',
    shadow: '#00161c',
    status: { busy: '#268bd2', waiting: '#b58900', idle: '#859900', error: '#dc322f', closed: '#586e75' },
    ansi: {
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
    syntax: SYNTAX_SOLARIZED,
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    group: 'light',
    dark: false,
    bg: '#fdf6e3',
    elev: -5,
    hi: '#073642',
    fg: '#4e646b',
    accent: '#268bd2',
    accentSoft: '#1a6ea8',
    accentText: '#ffffff',
    danger: '#dc322f',
    kindIcon: '#2aa198',
    shadow: '#586e75',
    status: { busy: '#268bd2', waiting: '#b58900', idle: '#859900', error: '#dc322f', closed: '#93a1a1' },
    ansi: {
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#93a1a1',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#657b83', brightYellow: '#839496',
      brightBlue: '#0d5c8c', brightMagenta: '#6c71c4', brightCyan: '#1f7a70', brightWhite: '#073642',
    },
    syntax: SYNTAX_SOLARIZED,
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    group: 'light',
    dark: false,
    bg: '#ffffff',
    elev: -5,
    surfaces: { input: '#ffffff' },
    hi: '#010409',
    fg: '#24292f',
    accent: '#0969da',
    accentSoft: '#0550ae',
    accentText: '#ffffff',
    danger: '#cf222e',
    kindIcon: '#6e7781',
    shadow: '#1f2328',
    status: { busy: '#0969da', waiting: '#9a6700', idle: '#1a7f37', error: '#cf222e', closed: '#8c959f' },
    ansi: ANSI_LIGHT,
    syntax: SYNTAX_LIGHT,
  },
  // ---- Apple Books reading presets ----
  {
    id: 'original',
    name: 'Original',
    group: 'reading',
    dark: false,
    bg: '#ffffff',
    elev: -5,
    surfaces: { input: '#ffffff' },
    hi: '#000000',
    fg: '#1c1c1e',
    accent: '#007aff',
    accentSoft: '#0060df',
    accentText: '#ffffff',
    danger: '#d70015',
    kindIcon: '#8e8e93',
    shadow: '#3a3a3c',
    status: { busy: '#007aff', waiting: '#c93400', idle: '#248a3d', error: '#d70015', closed: '#aeaeb2' },
    ansi: ANSI_LIGHT,
    syntax: SYNTAX_LIGHT,
  },
  {
    id: 'quiet',
    name: 'Quiet',
    group: 'reading',
    dark: true,
    bg: '#1c1c1e',
    elev: 9,
    hi: '#f2f2f7',
    fg: '#d1d1d6',
    accent: '#0a84ff',
    accentSoft: '#64b5ff',
    accentText: '#00182f',
    danger: '#ff453a',
    kindIcon: '#8e8e93',
    shadow: '#000000',
    status: { busy: '#0a84ff', waiting: '#ff9f0a', idle: '#30d158', error: '#ff453a', closed: '#636366' },
    ansi: {
      black: '#1c1c1e', red: '#ff453a', green: '#30d158', yellow: '#ffd60a',
      blue: '#0a84ff', magenta: '#bf5af2', cyan: '#40c8e0', white: '#d1d1d6',
      brightBlack: '#636366', brightRed: '#ff6961', brightGreen: '#4cd964', brightYellow: '#ffe066',
      brightBlue: '#409cff', brightMagenta: '#da8fff', brightCyan: '#70d7ff', brightWhite: '#f2f2f7',
    },
    syntax: SYNTAX_ONE_DARK,
  },
  {
    id: 'paper',
    name: 'Paper',
    group: 'reading',
    dark: false,
    bg: '#e6dfcf',
    elev: -6,
    hi: '#17150f',
    fg: '#33302a',
    accent: '#8a5a2b',
    accentSoft: '#6b4520',
    accentText: '#f7f2e6',
    danger: '#9c3b2e',
    kindIcon: '#7a6a52',
    shadow: '#4d4230',
    status: { busy: '#3f6280', waiting: '#8a5a2b', idle: '#4f7a3f', error: '#9c3b2e', closed: '#9a917f' },
    ansi: ANSI_SEPIA,
    syntax: SYNTAX_SEPIA,
    texture: PAPER_TEXTURE,
  },
  {
    id: 'bold',
    name: 'Bold',
    group: 'reading',
    dark: false,
    bg: '#ffffff',
    elev: -6,
    surfaces: { input: '#ffffff' },
    hi: '#000000',
    fg: '#000000',
    accent: '#0040dd',
    accentSoft: '#002ea6',
    accentText: '#ffffff',
    danger: '#b00020',
    kindIcon: '#3c3c3c',
    shadow: '#000000',
    status: { busy: '#0040dd', waiting: '#a35a00', idle: '#146b28', error: '#b00020', closed: '#6b6b6b' },
    ansi: ANSI_LIGHT,
    syntax: SYNTAX_LIGHT,
    uiWeight: 600,
  },
  {
    id: 'calm',
    name: 'Calm',
    group: 'reading',
    dark: false,
    bg: '#e8dcc4',
    elev: -6,
    hi: '#201a10',
    fg: '#3b3327',
    accent: '#a06a3c',
    accentSoft: '#7d4f27',
    accentText: '#fbf6ea',
    danger: '#97402f',
    kindIcon: '#857149',
    shadow: '#524632',
    status: { busy: '#4c6b86', waiting: '#a06a3c', idle: '#557a41', error: '#97402f', closed: '#9c9078' },
    ansi: ANSI_SEPIA,
    syntax: SYNTAX_SEPIA,
  },
  {
    id: 'focus',
    name: 'Focus',
    group: 'reading',
    dark: false,
    bg: '#f4f2e9',
    elev: -5,
    hi: '#16160f',
    fg: '#2f2f2b',
    accent: '#5d7a56',
    accentSoft: '#44603e',
    accentText: '#ffffff',
    danger: '#a03b2e',
    kindIcon: '#7d8072',
    shadow: '#4a4a40',
    status: { busy: '#4e6f8a', waiting: '#9a7a2e', idle: '#5d7a56', error: '#a03b2e', closed: '#9b9a90' },
    ansi: ANSI_SEPIA,
    syntax: SYNTAX_SEPIA,
  },
]

// ---- lookup, custom overrides, CSS variables --------------------------------

export const DEFAULT_THEME_ID = 'terminator'

export const THEMES: ThemePalette[] = THEME_SEEDS.map(buildPalette)

const BY_ID = new Map(THEMES.map((t) => [t.id, t]))

export function themeById(id: string | undefined): ThemePalette {
  return BY_ID.get(id ?? '') ?? BY_ID.get(DEFAULT_THEME_ID)!
}

/** Colour tokens a `customTheme` block may override (the flat, string-valued ones). */
export type ThemeOverrides = Partial<
  Record<
    RampKey | 'bg' | 'sidebar' | 'footer' | 'panel' | 'panel2' | 'input' | 'accent' | 'accentSoft'
    | 'accentText' | 'danger' | 'kindIcon' | 'shadow',
    string
  >
>

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * Resolve the palette a set of settings asks for: the named theme (falling back
 * to the default on an unknown id), with any `customTheme` colours laid over the
 * *derived* palette so an override beats the ramp. Values that aren't hex are
 * dropped rather than applied, so a hand-edited settings.json can't blank the UI.
 */
export function resolveTheme(theme: string | undefined, custom?: ThemeOverrides): ThemePalette {
  const base = themeById(theme)
  if (!custom) return base
  const out: ThemePalette = { ...base }
  for (const [key, value] of Object.entries(custom)) {
    if (typeof value !== 'string' || !COLOR_RE.test(value)) continue
    if (key === 'shadow') out.shadowRgb = rgbTriplet(value)
    else if (key in out) (out as unknown as Record<string, string>)[key] = value
  }
  // Keep the triplets in step with any overridden source colour.
  out.bgRgb = rgbTriplet(out.bg)
  out.inkRgb = rgbTriplet(out.text)
  out.accentRgb = rgbTriplet(out.accent)
  out.dangerRgb = rgbTriplet(out.danger)
  return out
}

/**
 * The palette as CSS custom properties. Alpha tints are deliberately *not*
 * variables of their own — components mix them from the `*-rgb` triplets, e.g.
 * `rgba(var(--c-ink-rgb),0.07)`.
 */
export function cssVars(p: ThemePalette): Record<string, string> {
  const vars: Record<string, string> = {
    '--c-bg': p.bg,
    '--c-sidebar': p.sidebar,
    '--c-footer': p.footer,
    '--c-panel': p.panel,
    '--c-panel2': p.panel2,
    '--c-input': p.input,
    '--c-text-max': p.textMax,
    '--c-text-hi': p.textHi,
    '--c-text-strong': p.textStrong,
    '--c-text': p.text,
    '--c-text-btn': p.textBtn,
    '--c-body': p.body,
    '--c-text-subtle': p.textSubtle,
    '--c-muted': p.muted,
    '--c-dim': p.dim,
    '--c-faint': p.faint,
    '--c-faint2': p.faint2,
    '--c-accent': p.accent,
    '--c-accent-soft': p.accentSoft,
    '--c-accent-text': p.accentText,
    '--c-danger': p.danger,
    '--c-kind-icon': p.kindIcon,
    '--c-bg-rgb': p.bgRgb,
    '--c-ink-rgb': p.inkRgb,
    '--c-accent-rgb': p.accentRgb,
    '--c-danger-rgb': p.dangerRgb,
    '--c-shadow-rgb': p.shadowRgb,
    '--c-status-waiting-rgb': rgbTriplet(p.status.waiting),
    '--c-ui-weight': String(p.uiWeight),
    '--c-texture': p.texture,
  }
  for (const [key, value] of Object.entries(p.status)) vars[`--c-status-${key}`] = value
  for (const [key, value] of Object.entries(p.syntax)) vars[`--c-syn-${key}`] = value
  return vars
}
