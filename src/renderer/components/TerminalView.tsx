import { useEffect, useRef } from 'react'
import * as registry from '../term/registry'
import { useStore } from '../state/store'
import { C } from '../theme'

/** Mounts a session's persistent xterm into this pane; starts it on first show. */
export function TerminalView({ id, active }: { id: string; active: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const everStarted = useStore((s) => s.sessions[id]?.everStarted ?? false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    registry.attach(id, el)

    const ro = new ResizeObserver(() => registry.refit(id))
    ro.observe(el)

    const raf = requestAnimationFrame(() => {
      const { cols, rows } = registry.refit(id)
      if (!everStarted) void window.terminator.startSession(id, cols, rows)
      if (active) registry.focus(id)
    })

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      registry.detach(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (active) registry.focus(id)
  }, [active, id])

  return (
    <div
      ref={ref}
      onMouseDown={() => registry.focus(id)}
      style={{ flex: 1, minHeight: 0, background: C.bg, padding: '6px 8px' }}
    />
  )
}
