// The window's half of a scripted `terminator new` (main/scripting.ts has the rest).
//
// It is the New Session dialog with the fields filled in by flags, and nothing
// else: the folder is read the way the dialog reads a typed one (`settleFolder`),
// the request is built the way the dialog builds it (`newSessionInput`), and the
// session is created through the same IPC. Where it differs is where it lands. The
// dialog puts a session in the pane you are in and hands it the keyboard; a script
// leaves the layout alone — the session starts off screen, in the sidebar, the way
// Start there leaves one — unless it asks for a pane with `--split`. Then it
// splits your pane and still leaves the keyboard alone: your pane stays the
// focused one, and the new session is marked quiet so its own pane doesn't take focus.

import type { BridgeNewArgs, BridgeReply, BridgeRequest } from '../shared/control'
import type { Side } from './state/paneTree'
import { errorText, startFromSidebar } from './menus'
import { newSessionInput, settleFolder } from './sessionTypes'
import { useStore } from './state/store'

const SIDE: Record<NonNullable<BridgeNewArgs['split']>, Side> = { left: 'left', right: 'right', up: 'top', down: 'bottom' }

async function createForScript(args: BridgeNewArgs): Promise<Omit<Extract<BridgeReply, { ok: true }>, 'reqId'>> {
  // The dialog refreshes the distro list whenever it opens; a bare `/…` folder
  // means the default one, so it has to be known.
  const distros = await useStore.getState().loadWslDistros(true)
  const { folder, runtime } = settleFolder(args.folder.trim(), args.runtime, distros)
  const session = await window.terminator.createSession(
    newSessionInput({
      type: args.kind,
      name: args.name,
      folder,
      worktree: args.worktree,
      branch: args.branch,
      runtime,
    }),
  )
  const st = useStore.getState()
  st.upsert(session)
  if (args.split) st.splitPane(session.id, st.focused, SIDE[args.split], { quiet: true })
  // One turn of the event loop, so the pane has rendered and its terminal is
  // attached there before it is measured; a size taken too early is corrected
  // by the pane's own ResizeObserver anyway.
  await new Promise((r) => setTimeout(r, 0))
  // Started now rather than on the pane's first animation frame, which never
  // comes while the window is minimised. The pane's own start then finds it
  // running and leaves it be.
  await startFromSidebar(session.id)
  // createSession reports a worktree that couldn't be made as an error status;
  // the session still opens, in the project itself, exactly as from the dialog.
  return session.status === 'error' ? { ok: true, id: session.id, createError: session.activity } : { ok: true, id: session.id }
}

/** Start answering main's requests. Called once the store has its sessions. */
export function listenForScripts(): void {
  window.terminator.onControlRequest((req: BridgeRequest) => {
    if (req.cmd !== 'new') return
    createForScript(req.args).then(
      (r) => window.terminator.controlReply({ reqId: req.reqId, ...r }),
      (e: unknown) => window.terminator.controlReply({ reqId: req.reqId, ok: false, error: errorText(e) }),
    )
  })
  window.terminator.onControlQuiet((id) => useStore.getState().quietWhenRemoved(id))
  window.terminator.controlReady()
}
