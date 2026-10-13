import type { ThemePalette } from '../../shared/themes'

// The filter that draws a PDF's pages in the theme's colours.
//
// One SVG <filter>, shared by every PDF pane and applied with CSS to the page
// canvases (pdf.css). A theme change rewrites one attribute here and every page
// repaints — open, parked offscreen, or half-way through rendering — with nothing
// re-rendered by pdf.js. The Themed/Original toggle is a class on the pane.
//
// The matrix moves each pixel's lightness from the paper-and-ink of print onto the
// theme's own, and keeps its hue:
//
//     out = c + Y·(paper − ink − 1) + ink        Y = 0.2126 R + 0.7152 G + 0.0722 B
//
// White (Y = 1) lands exactly on the theme's background and black (Y = 0) exactly on
// its text colour; everything between is spread linearly between the two, offset by
// how far the pixel was from grey. So red and blue text stay red and blue — lighter
// on a dark theme, where they'd otherwise be unreadable. pdf.js's own high-contrast
// filter posterises to six greys instead, which suits plain text and nothing else.
// Photos come out with their lightness inverted on a dark theme: that is what the
// Original toggle is for.

const ID = 'tm-pdf-recolor'
const LUMA = [0.2126, 0.7152, 0.0722]

let matrix: SVGFEColorMatrixElement | null = null
let current: { paper: number[]; ink: number[] } | null = null

function triplet(rgb: string): number[] {
  const parts = rgb.split(',').map((n) => Number(n) / 255)
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? parts : [0, 0, 0]
}

function values(paper: number[], ink: number[]): string {
  const rows: number[][] = []
  for (let x = 0; x < 3; x++) {
    const k = paper[x] - ink[x] - 1
    rows.push([0, 1, 2].map((c) => (c === x ? 1 : 0) + LUMA[c] * k).concat(0, ink[x]))
  }
  rows.push([0, 0, 0, 1, 0])
  return rows.map((r) => r.map((n) => +n.toFixed(5)).join(' ')).join('  ')
}

/**
 * Put the filter in the document, once. `visibility: hidden` and no size rather
 * than `display: none`, which would switch the filter off along with the element.
 */
export function ensureRecolorFilter(): void {
  if (matrix) return
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none'
  const filter = document.createElementNS(NS, 'filter')
  filter.id = ID
  // The theme's colours are sRGB, and so is the canvas: no conversion to linear light.
  filter.setAttribute('color-interpolation-filters', 'sRGB')
  matrix = document.createElementNS(NS, 'feColorMatrix')
  matrix.setAttribute('type', 'matrix')
  filter.appendChild(matrix)
  svg.appendChild(filter)
  document.body.appendChild(svg)
  if (current) matrix.setAttribute('values', values(current.paper, current.ink))
}

/** From applyTheme: the page colours follow the palette, live theme-editor drafts included. */
export function setRecolorTheme(p: ThemePalette): void {
  current = { paper: triplet(p.bgRgb), ink: triplet(p.inkRgb) }
  matrix?.setAttribute('values', values(current.paper, current.ink))
}
