import { cpSync, createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The data files pdf.js fetches at run time rather than importing: CMaps for CJK
// text whose fonts don't carry their own, the 14 standard fonts a PDF may name
// without embedding, and the wasm image decoders (JBIG2, CCITT, JPX — a scanned
// PDF's pages are blank without them). quickjs-eval.* is left out: it is only for
// PDF scripting, which the PDF pane never turns on.
const PDFJS_DIR = resolve(__dirname, 'node_modules/pdfjs-dist')
const PDFJS_ASSETS = ['cmaps', 'standard_fonts', 'wasm']
const PDFJS_SKIP = /^quickjs-eval\./

/**
 * Ship pdf.js's data files at `pdfjs/` beside the renderer's index.html — served
 * from node_modules in dev, copied into the output on build. The renderer finds
 * them relative to its own page (src/renderer/pdf/load.ts), which is http:// in
 * dev and file:// once packaged, so one URL rule covers both.
 */
function pdfjsAssets(): Plugin {
  return {
    name: 'terminator-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0])).replace(/^[/\\]+/, '')
        const top = rel.split(sep)[0]
        const file = join(PDFJS_DIR, rel)
        const skip = PDFJS_SKIP.test(file.split(sep).pop() ?? '')
        if (!PDFJS_ASSETS.includes(top) || skip || !file.startsWith(PDFJS_DIR + sep) || !existsSync(file)) {
          next()
          return
        }
        if (!statSync(file).isFile()) {
          next()
          return
        }
        if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
        else if (file.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript')
        createReadStream(file).pipe(res)
      })
    },
    writeBundle(opts) {
      if (!opts.dir) return
      for (const d of PDFJS_ASSETS) {
        cpSync(join(PDFJS_DIR, d), join(opts.dir, 'pdfjs', d), {
          recursive: true,
          filter: (src) => !PDFJS_SKIP.test(src.split(/[/\\]/).pop() ?? ''),
        })
      }
    },
  }
}

// Main + preload are bundled to CommonJS (no "type":"module" in package.json).
// externalizeDepsPlugin keeps `dependencies` (notably the native @lydell/node-pty)
// out of the bundle so they load from node_modules at runtime.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
    plugins: [react(), pdfjsAssets()],
  },
})
