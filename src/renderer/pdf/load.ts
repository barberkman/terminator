// pdf.js, loaded the first time a PDF pane needs it — about 1.3 MB of script that
// nothing else in the app uses, so app start never pays for it.
//
// Two things here are load-bearing:
//
//   • The order of the two imports. `pdf_viewer.mjs` reads `globalThis.pdfjsLib` the
//     moment it is evaluated and never imports `pdf.mjs` itself; `pdf.mjs` sets that
//     global as the last thing it does. A static import pair would leave the order to
//     the bundler.
//   • One shared PDFWorker, handed to every `getDocument`. Without it each document
//     makes a worker of its own and destroying the document destroys it — and with
//     `workerPort` instead of `workerSrc`, a worker that failed to start would hang
//     every load rather than letting pdf.js fall back to running in the page.

import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export type PdfjsLib = typeof import('pdfjs-dist')
export type PdfViewerLib = typeof import('pdfjs-dist/web/pdf_viewer.mjs')

export interface Pdfjs {
  lib: PdfjsLib
  viewer: PdfViewerLib
  worker: InstanceType<PdfjsLib['PDFWorker']>
}

/**
 * Where pdf.js finds its data files — CMaps, standard fonts, wasm image decoders.
 * They sit at `pdfjs/` beside index.html (see `pdfjsAssets` in electron.vite.config.ts),
 * so this is http:// in dev and file:// once built, and pdf.js copes with both.
 */
const ASSETS = new URL('pdfjs/', document.baseURI).href
export const ASSET_URLS = {
  cMapUrl: `${ASSETS}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ASSETS}standard_fonts/`,
  wasmUrl: `${ASSETS}wasm/`,
} as const

let loading: Promise<Pdfjs> | null = null

export function loadPdfjs(): Promise<Pdfjs> {
  if (!loading) {
    loading = (async () => {
      const lib = await import('pdfjs-dist')
      const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs')
      // The viewer's stylesheet sets `color-scheme` on :root; theme-apply.ts writes
      // it as an inline style on the same element, which wins, so the app's own
      // light/dark choice is untouched. Ours comes after it to override.
      await import('pdfjs-dist/web/pdf_viewer.css')
      await import('./pdf.css')
      lib.GlobalWorkerOptions.workerSrc = workerUrl
      const worker = new lib.PDFWorker()
      return { lib, viewer, worker }
    })()
    // A failed load (a chunk that didn't arrive) shouldn't be cached forever.
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}
