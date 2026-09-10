import { useEffect, useRef, useState } from 'react'
import {
  RAMP_KEYS,
  SURFACE_KEYS,
  type AnsiPalette,
  type CustomTheme,
  type RampKey,
  type SyntaxPalette,
  type Surfaces,
  buildPalette,
  contrastWarnings,
  exportTheme,
  newThemeId,
} from '../../shared/themes'
import type { SessionStatus } from '../../shared/types'
import { C, dotStyle, sz } from '../theme'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import { applyTheme } from '../theme-apply'
import { freeName, upsert, writeThemes } from '../themeActions'
import { Choice, Field, Section, inputStyle, smallBtn } from './controls'
import { ColorField, ContrastNotes } from './ColorField'
import { ThemeCodeSample } from './ThemeCodeSample'

const ANSI_KEYS: (keyof AnsiPalette)[] = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
]

const SYNTAX_KEYS: (keyof SyntaxPalette)[] = [
  'keyword', 'name', 'func', 'constant', 'def', 'type', 'operator', 'comment', 'string', 'invalid',
]

const STATUS_KEYS: SessionStatus[] = ['busy', 'waiting', 'idle', 'error', 'closed']

/** The nine ramp steps between the two anchors — the ones worth pinning. */
const RAMP_PINNABLE = RAMP_KEYS.filter((k) => k !== 'textMax' && k !== 'text')

const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px 16px' }

function headerBtn(label: string, onClick: () => void, danger = false): React.JSX.Element {
  return (
    <button
      key={label}
      onClick={onClick}
      style={{ ...smallBtn, color: danger ? C.danger : C.muted, borderColor: danger ? C.border3 : C.border2 }}
    >
      {label}
    </button>
  )
}

/**
 * The theme editor: a full view rather than another block in the Settings scroll,
 * because there are seventy-odd values in here and Settings is the thing this
 * change set out to shorten.
 *
 * Nothing in here previews. Every edit goes through `applyTheme`, the same call
 * the picker makes, so the whole app *is* the preview — chrome, both editors, and
 * every terminal including the ones parked off-screen. Edits save themselves a
 * beat after you stop typing; there is no Save button to leave the app painted in
 * something that never reached disk.
 */
export function ThemeEditorView(): React.JSX.Element | null {
  const id = useStore((s) => s.themeEditorFor)
  const setId = useStore((s) => s.setThemeEditorFor)
  const customThemes = useStore((s) => s.customThemes)
  const [draft, setDraft] = useState<CustomTheme | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({
    base: true, surfaces: true, terminal: true, syntax: true, details: false,
  })
  const [transfer, setTransfer] = useState<string | null>(null)
  const [askDelete, setAskDelete] = useState(false)

  const paint = useRef(0)
  const pending = useRef<number | null>(null)
  // Read by the flush below, which must not close over a stale draft.
  const latest = useRef<CustomTheme | null>(null)

  /** Land whatever the debounce is still holding. */
  const flush = (): void => {
    if (pending.current !== null) {
      window.clearTimeout(pending.current)
      pending.current = null
    }
    const seed = latest.current
    if (seed) void writeThemes(upsert(useStore.getState().customThemes, seed))
  }

  const stored = customThemes.find((t) => t.id === id) ?? null
  useEffect(() => {
    setDraft(stored)
    latest.current = stored
    setTransfer(null)
    setAskDelete(false)
    // The cleanup runs before the next theme is seeded, so leaving the editor —
    // by Done, by Esc, or by opening a different theme — always lands the last
    // few hundred milliseconds rather than leaving them to a stray timer.
    return () => flush()
    // Only when the editor moves to a different theme: re-seeding on every change
    // to the stored list would fight the draft the moment autosave lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (!id || !draft) return null

  /**
   * Repaint now, save shortly. The paint is coalesced to one frame because
   * dragging a colour picker fires continuously and each apply reassigns the
   * theme on every live xterm — which is a full repaint per pane.
   */
  const commit = (next: CustomTheme): void => {
    setDraft(next)
    latest.current = next
    cancelAnimationFrame(paint.current)
    paint.current = requestAnimationFrame(() => applyTheme(buildPalette(next)))
    if (pending.current !== null) window.clearTimeout(pending.current)
    pending.current = window.setTimeout(() => {
      pending.current = null
      void writeThemes(upsert(useStore.getState().customThemes, next))
    }, 400)
  }

  const palette = buildPalette(draft)
  // The same theme with its pins lifted — i.e. what each pinnable field would
  // fall back to. One build serves both the surfaces and the ramp.
  const bare = buildPalette({ ...draft, surfaces: undefined, ramp: undefined })
  const warnings = contrastWarnings(palette)
  const notes = (section: 'base' | 'terminal' | 'details') => warnings.filter((w) => w.section === section)

  const set = (p: Partial<CustomTheme>) => commit({ ...draft, ...p })

  const setSurface = (key: keyof Surfaces, hex: string) =>
    commit({ ...draft, surfaces: { ...draft.surfaces, [key]: hex } })
  const unpinSurface = (key: keyof Surfaces) => {
    const surfaces = { ...draft.surfaces }
    delete surfaces[key]
    commit({ ...draft, surfaces: Object.keys(surfaces).length > 0 ? surfaces : undefined })
  }
  const setRamp = (key: RampKey, hex: string) => commit({ ...draft, ramp: { ...draft.ramp, [key]: hex } })
  const unpinRamp = (key: RampKey) => {
    const ramp = { ...draft.ramp }
    delete ramp[key]
    commit({ ...draft, ramp: Object.keys(ramp).length > 0 ? ramp : undefined })
  }
  const unpin = (key: 'cursor' | 'cursorText' | 'selection') => {
    const next = { ...draft }
    delete next[key]
    commit(next)
  }

  const duplicate = () => {
    // Copied from the draft rather than the stored seed, so duplicating mid-edit
    // forks what is on screen — which is what it looks like it should do.
    const copy: CustomTheme = {
      ...draft,
      surfaces: draft.surfaces && { ...draft.surfaces },
      ramp: draft.ramp && { ...draft.ramp },
      status: { ...draft.status },
      ansi: { ...draft.ansi },
      syntax: { ...draft.syntax },
      id: newThemeId(),
      name: freeName(draft.name, customThemes.map((t) => t.name)),
      from: draft.name,
      createdAt: Date.now(),
    }
    flush()
    void (async () => {
      await writeThemes(upsert(useStore.getState().customThemes, copy))
      const settings = await window.terminator.updateSettings({ theme: copy.id })
      useStore.getState().setSettings(settings)
      setId(copy.id)
    })()
  }

  const remove = () => {
    if (pending.current !== null) window.clearTimeout(pending.current)
    pending.current = null
    latest.current = null
    setId(null)
    // The main process moves the selection to the default when the theme that
    // just vanished was the one in use, and hands the repaired settings back.
    void writeThemes(customThemes.filter((t) => t.id !== draft.id))
  }

  const close = () => {
    flush()
    setId(null)
  }

  const section = (key: string, label: string, summary: React.ReactNode, children: React.ReactNode) => (
    <Section
      label={label}
      summary={summary}
      open={open[key] ?? false}
      onToggle={() => setOpen({ ...open, [key]: !(open[key] ?? false) })}
    >
      {children}
    </Section>
  )

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        // Above Settings (50), below the confirm dialog (55) and Notes (60).
        zIndex: 52,
        background: C.scrim,
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'cc-fade 0.18s ease',
      }}
    >
      <div
        style={{
          width: 880,
          maxWidth: '96vw',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          background: C.panel,
          border: `1px solid ${C.border3}`,
          borderRadius: 14,
          boxShadow: C.shadowModal,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '16px 18px 12px', flex: 'none' }}>
          <span style={{ display: 'flex', color: C.accent }}>
            <Icon name="pencil" size={15} />
          </span>
          <input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Theme name"
            style={{ ...inputStyle, width: 220, flex: 'none', fontSize: 13, fontWeight: 600, color: C.textMax }}
          />
          {draft.from && <span style={{ fontSize: 10.5, color: C.faint }}>from {draft.from}</span>}
          {warnings.length > 0 && (
            <span style={{ fontSize: 10.5, color: 'var(--c-status-waiting)' }}>
              {warnings.length} readability {warnings.length === 1 ? 'warning' : 'warnings'}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            {headerBtn(transfer === null ? 'Export' : 'Hide export', () =>
              setTransfer(transfer === null ? exportTheme(draft) : null),
            )}
            {headerBtn('Duplicate', duplicate)}
            {askDelete ? (
              <>
                <span style={{ fontSize: 10.5, color: C.body }}>Delete {draft.name}?</span>
                {headerBtn('Cancel', () => setAskDelete(false))}
                {headerBtn('Delete', remove, true)}
              </>
            ) : (
              headerBtn('Delete', () => setAskDelete(true), true)
            )}
            <button
              onClick={close}
              title="Done"
              style={{ display: 'flex', width: sz(26), height: sz(26), alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer' }}
            >
              <Icon name="close" size={13} />
            </button>
          </span>
        </div>

        <div style={{ padding: '0 18px 4px', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {transfer !== null && (
            <div style={{ paddingBottom: 14 }}>
              <Field label="THIS THEME AS TEXT" hint="Send it to someone, or keep it somewhere. Paste one back in from Settings → THEME → Import.">
                <textarea
                  readOnly
                  value={transfer}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ ...inputStyle, height: 150, resize: 'vertical', fontSize: 11, lineHeight: 1.5 }}
                />
                <button
                  onClick={() => window.terminator.clipboardWrite(transfer)}
                  style={{ ...smallBtn, marginTop: 8 }}
                >
                  Copy
                </button>
              </Field>
            </div>
          )}

          {section('base', 'THE BASICS', 'background, text, accents', (
            <>
              <ContrastNotes warnings={notes('base')} />
              <Field label="LIGHT OR DARK" hint="Drives the editor's own chrome, the window's form controls and scrollbars, and how far the dim half of the text ramp fades.">
                <Choice
                  value={draft.dark}
                  onPick={(dark) => set({ dark })}
                  options={[
                    { value: true, label: 'Dark' },
                    { value: false, label: 'Light' },
                  ]}
                />
              </Field>
              <Field label="COLOURS" hint="Everything else is shaded from these: the surfaces from the background, and the eleven text shades between the two text anchors.">
                <div style={grid2}>
                  <ColorField label="background" value={draft.bg} onChange={(bg) => set({ bg })} />
                  <ColorField label="headings" value={draft.hi} onChange={(hi) => set({ hi })} />
                  <ColorField label="body text" value={draft.fg} onChange={(fg) => set({ fg })} />
                  <ColorField label="accent" value={draft.accent} onChange={(accent) => set({ accent })} />
                  <ColorField label="accent (soft)" value={draft.accentSoft} onChange={(accentSoft) => set({ accentSoft })} />
                  <ColorField label="text on accent" value={draft.accentText} onChange={(accentText) => set({ accentText })} />
                  <ColorField label="danger" value={draft.danger} onChange={(danger) => set({ danger })} />
                </div>
              </Field>
            </>
          ))}

          {section('surfaces', 'DEPTH', `${draft.elev > 0 ? '+' : ''}${draft.elev}`, (
            <>
              <Field label="HOW FAR THE CHROME SITS FROM THE BACKGROUND" hint="One control for the sidebar, footer and panels together. Positive lifts them off the background — right for dark themes, and for light ones whose panels read as white cards; negative sinks them, which is what the reading presets want. A pinned surface ignores this.">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <input
                    type="range"
                    min={-20}
                    max={20}
                    step={1}
                    value={draft.elev}
                    onChange={(e) => set({ elev: Number(e.target.value) })}
                    style={{ flex: 1, accentColor: C.accent }}
                  />
                  <input
                    type="number"
                    min={-20}
                    max={20}
                    style={{ ...inputStyle, width: 70, flex: 'none' }}
                    value={draft.elev}
                    onChange={(e) => set({ elev: Math.max(-20, Math.min(20, Number(e.target.value) || 0)) })}
                  />
                </div>
                <div style={{ display: 'flex', gap: 1, marginTop: 10, borderRadius: 8, overflow: 'hidden' }}>
                  {(['bg', ...SURFACE_KEYS] as const).map((key) => (
                    <div
                      key={key}
                      title={`${key} — ${palette[key]}`}
                      style={{
                        flex: 1,
                        height: 44,
                        background: palette[key],
                        display: 'flex',
                        alignItems: 'flex-end',
                        justifyContent: 'center',
                        paddingBottom: 4,
                        fontSize: 9,
                        color: palette.muted,
                      }}
                    >
                      {key}
                    </div>
                  ))}
                </div>
              </Field>
              <Field label="OR PIN ONE" hint="A pinned surface keeps its colour whatever the slider does. Unpin to hand it back.">
                <div style={grid2}>
                  {SURFACE_KEYS.map((key) => (
                    <ColorField
                      key={key}
                      label={key}
                      value={palette[key]}
                      derived={bare[key]}
                      pinned={draft.surfaces?.[key] !== undefined}
                      onChange={(hex) => setSurface(key, hex)}
                      onUnpin={() => unpinSurface(key)}
                    />
                  ))}
                </div>
              </Field>
            </>
          ))}

          {section('terminal', 'TERMINAL', 'the ANSI set, cursor and selection', (
            <>
              <ContrastNotes warnings={notes('terminal')} />
              <Field label="ANSI COLOURS" hint="What programs in a pane paint with — Claude's TUI included. Published palettes are almost always these sixteen.">
                <div style={grid2}>
                  {ANSI_KEYS.map((key) => (
                    <ColorField
                      key={key}
                      label={key}
                      value={draft.ansi[key]}
                      warning={warnings.find((w) => w.label === `Terminal ${key}`)}
                      onChange={(hex) => set({ ansi: { ...draft.ansi, [key]: hex } })}
                    />
                  ))}
                </div>
                <div
                  style={{
                    marginTop: 10,
                    padding: '9px 11px',
                    borderRadius: 9,
                    background: palette.bg,
                    border: `1px solid ${palette.panel2}`,
                    fontSize: 11.5,
                    lineHeight: 1.6,
                    whiteSpace: 'pre',
                    overflowX: 'auto',
                  }}
                >
                  <div>
                    <span style={{ color: palette.ansi.green }}>~/src/terminator</span>
                    <span style={{ color: palette.ansi.blue }}> (main)</span>
                    <span style={{ color: palette.text }}> $ npm test</span>
                    <span style={{ background: palette.cursor, color: palette.cursorText }}> </span>
                  </div>
                  <div>
                    <span style={{ color: palette.ansi.brightGreen }}>  ✓ </span>
                    <span style={{ color: palette.text }}>18 passed </span>
                    <span style={{ color: palette.ansi.brightBlack }}>(1.2s)</span>
                  </div>
                  <div>
                    <span style={{ color: palette.ansi.brightRed }}>  ✗ </span>
                    <span style={{ color: palette.text }}>1 failed — </span>
                    <span style={{ color: palette.ansi.yellow }}>themes.test.ts</span>
                  </div>
                  <div>
                    <span style={{ color: palette.text }}>  selection looks </span>
                    <span style={{ background: palette.selection, color: palette.text }}>like this</span>
                    <span style={{ color: palette.text }}> in a pane</span>
                  </div>
                </div>
              </Field>
              <Field label="CURSOR AND SELECTION" hint="Derived from the accent and the background until you pin them.">
                <div style={grid2}>
                  <ColorField
                    label="cursor"
                    value={palette.cursor}
                    derived={draft.accent}
                    pinned={draft.cursor !== undefined}
                    onChange={(cursor) => set({ cursor })}
                    onUnpin={() => unpin('cursor')}
                  />
                  <ColorField
                    label="glyph under the cursor"
                    value={palette.cursorText}
                    derived={draft.bg}
                    pinned={draft.cursorText !== undefined}
                    onChange={(cursorText) => set({ cursorText })}
                    onUnpin={() => unpin('cursorText')}
                  />
                  <ColorField
                    label="selection"
                    value={palette.selectionHex}
                    derived={draft.accent}
                    pinned={draft.selection !== undefined}
                    onChange={(selection) => set({ selection })}
                    onUnpin={() => unpin('selection')}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="range"
                      min={5}
                      max={90}
                      step={5}
                      value={Math.round(palette.selectionAlpha * 100)}
                      onChange={(e) => set({ selectionAlpha: Number(e.target.value) / 100 })}
                      style={{ flex: 1, accentColor: C.accent }}
                    />
                    <span style={{ fontSize: 11, color: C.body, flex: 'none' }}>
                      {Math.round(palette.selectionAlpha * 100)}% opaque
                    </span>
                  </div>
                </div>
              </Field>
            </>
          ))}

          {section('syntax', 'EDITOR SYNTAX', 'ten token colours', (
            <Field label="TOKEN COLOURS" hint="Used by the in-app Editor panes and by code blocks in a conversation.">
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: '0 0 250px' }}>
                  {SYNTAX_KEYS.map((key) => (
                    <ColorField
                      key={key}
                      label={key}
                      value={draft.syntax[key]}
                      onChange={(hex) => set({ syntax: { ...draft.syntax, [key]: hex } })}
                    />
                  ))}
                </div>
                <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                  <ThemeCodeSample palette={palette} />
                </div>
              </div>
            </Field>
          ))}

          {section('details', 'THE FINER THINGS', 'status colours, shadows, the text ramp', (
            <>
              <ContrastNotes warnings={notes('details')} />
              <Field label="SESSION STATUS" hint="The app's main signal — the sidebar dots, the pane headers and the footer all read from these.">
                <div style={grid2}>
                  {STATUS_KEYS.map((key) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ ...dotStyle(key), background: draft.status[key], animation: undefined, flex: 'none' }} />
                      <ColorField
                        label={key}
                        value={draft.status[key]}
                        onChange={(hex) => set({ status: { ...draft.status, [key]: hex } })}
                      />
                    </div>
                  ))}
                </div>
              </Field>
              <Field label="SHADOWS AND ICONS">
                <div style={grid2}>
                  <ColorField label="shadow and scrim" value={draft.shadow} onChange={(shadow) => set({ shadow })} />
                  <ColorField label="session-kind icons" value={draft.kindIcon} onChange={(kindIcon) => set({ kindIcon })} />
                </div>
              </Field>
              <Field label="INTERFACE FONT WEIGHT" hint="The app chrome only; the terminal and editor keep their own.">
                <Choice
                  value={draft.uiWeight ?? 400}
                  onPick={(uiWeight) => set({ uiWeight })}
                  options={[
                    { value: 400 as const, label: 'Regular' },
                    { value: 500 as const, label: 'Medium' },
                    { value: 600 as const, label: 'Semibold' },
                  ]}
                />
              </Field>
              <Field
                label="THE TEXT RAMP"
                hint="Nine shades faded between the two text anchors and the background. Pin one to hold it still; unpin to hand it back to the derivation."
              >
                <div style={grid2}>
                  {RAMP_PINNABLE.map((key) => (
                    <ColorField
                      key={key}
                      label={key}
                      value={palette[key]}
                      derived={bare[key]}
                      pinned={draft.ramp?.[key] !== undefined}
                      onChange={(hex) => setRamp(key, hex)}
                      onUnpin={() => unpinRamp(key)}
                    />
                  ))}
                </div>
                <div style={{ fontSize: 10.5, color: C.faint, marginTop: 8 }}>
                  The two ends of the ramp are the anchors themselves — headings are{' '}
                  <span style={{ color: C.dim }}>{draft.hi}</span> and body text is{' '}
                  <span style={{ color: C.dim }}>{draft.fg}</span>, both set under The basics.
                </div>
              </Field>
            </>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px 16px', flex: 'none' }}>
          <span style={{ fontSize: 10.5, color: C.faint }}>
            Changes are live everywhere and save themselves.
          </span>
          <button
            onClick={close}
            style={{ marginLeft: 'auto', padding: '9px 20px', background: C.accent, border: 'none', borderRadius: 9, color: C.accentText, font: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
