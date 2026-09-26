import { useCallback, useEffect, useState } from 'react'
import type { WslDistro, WslProbe } from '../../shared/types'
import { C, STATUS_COLORS } from '../theme'
import { useStore } from '../state/store'
import { smallBtn } from './controls'

/**
 * What each installed distro said about itself — the things a WSL session depends
 * on that can't be seen from Windows: whether `claude` is there, and whether the
 * way back to this app (interop) is open. Mounted only while its Settings section is
 * open, because asking a stopped distro boots it.
 */
export function WslDistroStatus(): React.JSX.Element {
  const distros = useStore((s) => s.wslDistros) ?? []
  const [probes, setProbes] = useState<Record<string, WslProbe | 'asking'>>({})

  const check = useCallback(async (force: boolean) => {
    const list: WslDistro[] = await useStore.getState().loadWslDistros(force)
    setProbes(Object.fromEntries(list.map((d) => [d.name, 'asking' as const])))
    await Promise.all(
      list.map(async (d) => {
        let p: WslProbe
        try {
          p = await window.terminator.wslProbe(d.name, force)
        } catch (e) {
          p = { distro: d.name, ok: false, reason: String(e) } as WslProbe
        }
        setProbes((cur) => ({ ...cur, [d.name]: p }))
      }),
    )
  }, [])

  useEffect(() => {
    void check(false)
  }, [check])

  if (!distros.length) {
    return (
      <div style={{ fontSize: 11.5, color: C.dim }}>
        No WSL distros are installed. Install one (<code>wsl --install</code>) and it shows up here and in
        New Session.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {distros.map((d) => {
        const p = probes[d.name]
        return (
          <div key={d.name} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 12.5, color: C.textHi }}>{d.name}</span>
              <span style={{ fontSize: 10.5, color: C.dim }}>
                WSL {d.version}
                {d.isDefault ? ' · default' : ''}
              </span>
            </div>
            <div style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.5 }}>{describe(p)}</div>
          </div>
        )
      })}
      <div>
        <button style={smallBtn} onClick={() => void check(true)}>
          Check again
        </button>
      </div>
    </div>
  )
}

function describe(p: WslProbe | 'asking' | undefined): React.ReactNode {
  if (!p || p === 'asking') return 'asking…'
  if (!p.ok) return <span style={{ color: STATUS_COLORS.error }}>{p.reason || "didn't answer"}</span>
  const bad = (text: string) => <span style={{ color: STATUS_COLORS.error }}>{text}</span>
  return (
    <>
      {p.user} · {p.home} · {p.shell.split('/').pop()}
      {' · '}
      {p.claudePath ? `claude at ${p.claudePath}` : bad('claude not found on PATH')}
      {' · '}
      {p.interop && p.exeReachable ? 'status reporting on' : bad('interop off — no status reporting')}
      {p.networking ? ` · ${p.networking} networking` : ''}
      {p.gitVersion ? '' : <> · {bad('git not found')}</>}
    </>
  )
}
