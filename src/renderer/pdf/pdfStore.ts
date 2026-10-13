import { create } from 'zustand'
import type { FindHits } from '../find'

// What a PDF pane's chrome renders from: one plain record per session. The live
// pdf.js viewer and its document live in the registry (registry.ts), never here —
// the same split the editor makes between editorStore and its registry.

export type PdfStatus = 'loading' | 'ok' | 'missing' | 'tooLarge' | 'password' | 'error'

export interface PdfView {
  status: PdfStatus
  /** What went wrong, for `error`. */
  error?: string
  /** The password just tried was wrong — the prompt says so. */
  wrongPassword?: boolean
  /** The file was removed or replaced by something unreadable after it had loaded. */
  gone?: boolean
  numPages: number
  page: number
  /** pdf.js's own scale value: a preset ('auto', 'page-fit', 'page-width') or a number. */
  scaleValue: string
  /** The scale actually in force, for the percentage readout. */
  scale: number
  /** Pages drawn in the theme's colours rather than as printed. */
  recolor: boolean
  /** The document's own title, when it has one. */
  title?: string
  findHits: FindHits
}

const EMPTY: PdfView = {
  status: 'loading',
  numPages: 0,
  page: 1,
  scaleValue: 'auto',
  scale: 1,
  recolor: true,
  findHits: { index: 0, total: 0 },
}

interface PdfStoreState {
  sessions: Record<string, PdfView>
  patch(id: string, patch: Partial<PdfView>): void
  clear(id: string): void
}

export const usePdfStore = create<PdfStoreState>((set) => ({
  sessions: {},
  patch: (id, patch) =>
    set((st) => ({ sessions: { ...st.sessions, [id]: { ...(st.sessions[id] ?? EMPTY), ...patch } } })),
  clear: (id) =>
    set((st) => {
      if (!(id in st.sessions)) return {}
      const sessions = { ...st.sessions }
      delete sessions[id]
      return { sessions }
    }),
}))

export function pdfView(id: string): PdfView {
  return usePdfStore.getState().sessions[id] ?? EMPTY
}

export { EMPTY as EMPTY_PDF_VIEW }
