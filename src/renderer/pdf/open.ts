import type { Session } from '../../shared/types'
import { useStore } from '../state/store'

// Every way into a PDF pane but the New Session dialog: a click in an Editor pane's
// tree, Quick Open, a path Ctrl+clicked in a terminal, the sidebar's "New session
// here". They all end here so that one file is one pane — a second click on a PDF
// that is already open brings that pane forward rather than opening it twice.

/** Whether a path names a PDF — by its extension, which is all a click has to go on. */
export function isPdfPath(p: string): boolean {
  return /\.pdf$/i.test(p)
}

/**
 * A path in the form two spellings of the same file agree on: the tree joins with
 * `/` onto a root main wrote with `\`, and Windows doesn't care about case.
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    return window.terminator.platform === 'win32' ? s.toLowerCase() : s
  }
  // A UNC path's leading `//` is part of it; collapsing it on both sides keeps them equal.
  return norm(a) === norm(b)
}

export function pdfSessionFor(path: string): Session | undefined {
  return Object.values(useStore.getState().sessions).find(
    (s) => s.kind === 'pdf' && !!s.file && samePath(s.file, path),
  )
}

/** Requests in flight, per file: a double-click's two clicks make one session. */
const making = new Map<string, Promise<Session | null>>()

function toastError(sub: string): void {
  useStore.getState().pushToast({ tone: 'error', text: "Couldn't open the PDF", sub })
}

/**
 * Make a PDF session for `path` in a folder, or say why not. The file can be
 * anywhere: the folder only decides the sidebar group it lands in, and the session
 * reads that one file and nothing else.
 */
export async function createPdfSession(
  project: { name: string; path: string; runtime?: Session['runtime'] },
  path: string,
): Promise<Session | null> {
  const key = path.replace(/\\/g, '/').toLowerCase()
  const pending = making.get(key)
  if (pending) return pending
  const run = (async () => {
    try {
      const made = await window.terminator.createSession({
        kind: 'pdf',
        mode: 'normal',
        projectName: project.name,
        projectPath: project.path,
        ...(project.runtime ? { runtime: project.runtime } : {}),
        file: path,
      })
      useStore.getState().upsert(made)
      return made
    } catch (e) {
      // Main's reason, without Electron's "Error invoking remote method" wrapper.
      const raw = e instanceof Error ? e.message : String(e)
      toastError(raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 200))
      return null
    } finally {
      making.delete(key)
    }
  })()
  making.set(key, run)
  return run
}

/**
 * Show `path` — absolute, found through `fromSessionId` — in a PDF pane.
 *
 * Where it lands: `beside` (a click in an Editor pane's tree, or its Quick Open)
 * puts it in a split to the right of that pane, so the tree you're browsing stays
 * on screen — or into the PDF pane already standing there, so clicking through a
 * folder of PDFs doesn't split the window over and over. Otherwise it takes the
 * focused pane, which is what a clicked link to a page or a file already does.
 */
export async function openPdf(fromSessionId: string, path: string, opts: { beside?: boolean } = {}): Promise<void> {
  const st = useStore.getState()
  let target = pdfSessionFor(path)
  if (!target) {
    const from = st.sessions[fromSessionId]
    if (!from?.projectPath) {
      toastError('the session it came from has no folder')
      return
    }
    // Grouped with the session that asked — under its worktree, if it has one, since
    // that is the folder the path was found from — and labelled with its project's name.
    target =
      (await createPdfSession(
        { name: from.projectName, path: from.worktreePath || from.projectPath, runtime: from.runtime },
        path,
      )) ?? undefined
    if (!target) return
  }
  place(target.id, fromSessionId, !!opts.beside)
}

function place(id: string, fromSessionId: string, beside: boolean): void {
  const st = useStore.getState()
  // Already on screen: just go there.
  if (!beside || st.panes.includes(id)) {
    st.openSession(id)
    return
  }
  const at = st.panes.indexOf(fromSessionId)
  if (at < 0) {
    st.openSession(id)
    return
  }
  // A PDF pane already beside it takes the new document, the way a preview tab does.
  const next = at + 1 < st.panes.length ? st.sessions[st.panes[at + 1]] : undefined
  if (next?.kind === 'pdf') {
    st.openInPane(id, at + 1)
    return
  }
  st.splitPane(id, at, 'right')
}
