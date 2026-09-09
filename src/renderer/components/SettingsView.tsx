import { useEffect, useState } from 'react'
import type { BrowserOption, NotifType, Settings } from '../../shared/types'
import { formatArgs, parseArgs } from '../../shared/args'
import { C, STATUS_COLORS, accentA, sz } from '../theme'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import { ThemePicker } from './ThemePicker'
import { applyThemeFromSettings } from '../theme-apply'
import { eventToAccelerator } from '../shortcuts'

const NOTIF_TYPES: NotifType[] = ['waiting', 'finished', 'error', 'exited']

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  background: C.input,
  border: `1px solid ${C.border2}`,
  borderRadius: 8,
  color: C.textHi,
  font: 'inherit',
  fontSize: 12.5,
  outline: 'none',
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, letterSpacing: 0.5, color: C.muted, fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10.5, color: C.dim, marginTop: 5 }}>{hint}</div>}
    </div>
  )
}

/** Ids only have to be unique within the list and stable across edits. */
function newBrowserId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

/** Click-to-record control: captures a key combo and emits an Electron accelerator. */
function ShortcutRecorder({ value, onChange }: { value: string; onChange: (accel: string) => void }): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <button
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return
          // Capture every key while recording so combos like Ctrl+N don't leak to
          // the app's global handlers.
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'Escape') {
            setRecording(false)
            return
          }
          if (MODIFIER_KEYS.has(e.key)) return // wait for a non-modifier key
          const accel = eventToAccelerator(e)
          if (accel) {
            onChange(accel)
            setRecording(false)
          }
        }}
        style={{
          ...inputStyle,
          flex: 1,
          textAlign: 'left',
          cursor: 'pointer',
          color: recording ? C.accentSoft : value ? C.textHi : C.dim,
          borderColor: recording ? C.accentBorder : C.border2,
        }}
      >
        {recording ? 'Press keys…  (Esc to cancel)' : value || 'Not set — click to record'}
      </button>
      <button
        onClick={() => onChange('')}
        title="Disable the global shortcut"
        style={{
          padding: '0 14px',
          background: C.input,
          border: `1px solid ${C.border3}`,
          borderRadius: 8,
          color: C.muted,
          font: 'inherit',
          fontSize: 12,
          cursor: 'pointer',
          flex: 'none',
        }}
      >
        Clear
      </button>
    </div>
  )
}

const smallBtn: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: 7,
  border: `1px solid ${C.border2}`,
  background: 'transparent',
  color: C.muted,
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
  flex: 'none',
}

/** A two-option toggle, the shape Settings already uses for its either/ors. */
function Choice<T extends string | boolean>({
  options,
  value,
  onPick,
}: {
  options: { value: T; label: string }[]
  value: T
  onPick: (v: T) => void
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {options.map((o) => {
        const on = value === o.value
        return (
          <button
            key={String(o.value)}
            onClick={() => onPick(o.value)}
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 8,
              border: `1px solid ${on ? C.accentBorder : C.border2}`,
              background: on ? accentA(0.12) : 'transparent',
              color: on ? C.accentSoft : C.muted,
              font: 'inherit',
              fontSize: 12.5,
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * One configured browser. The arguments box is free text while you type and is
 * parsed into a real argv array on the way into settings, so quoting behaves the
 * way a shell trains you to expect without a shell ever being involved.
 */
function BrowserRow({
  browser,
  isDefault,
  onChange,
  onMakeDefault,
  onRemove,
}: {
  browser: BrowserOption
  isDefault: boolean
  onChange: (b: BrowserOption) => void
  onMakeDefault: () => void
  onRemove: () => void
}): React.JSX.Element {
  const [argsText, setArgsText] = useState(() => formatArgs(browser.args))

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 10,
        borderRadius: 9,
        border: `1px solid ${isDefault ? C.accentBorder : C.border2}`,
        background: isDefault ? accentA(0.05) : 'transparent',
      }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ ...inputStyle, flex: 1 }}
          placeholder="Chrome incognito"
          value={browser.name}
          onChange={(e) => onChange({ ...browser, name: e.target.value })}
        />
        <button
          onClick={onMakeDefault}
          title={isDefault ? 'Clicked links use this one' : 'Use this one for a plain click'}
          style={{
            ...smallBtn,
            border: `1px solid ${isDefault ? C.accentBorder : C.border2}`,
            background: isDefault ? accentA(0.12) : 'transparent',
            color: isDefault ? C.accentSoft : C.muted,
          }}
        >
          {isDefault ? '✓ Default' : 'Make default'}
        </button>
        <button onClick={onRemove} title="Remove this browser" style={{ ...smallBtn, color: C.danger }}>
          Remove
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ ...inputStyle, flex: 1 }}
          placeholder="/usr/bin/google-chrome   or   C:\Program Files\Google\Chrome\Application\chrome.exe"
          value={browser.command}
          onChange={(e) => onChange({ ...browser, command: e.target.value })}
        />
        <button
          onClick={() => {
            void window.terminator.pickFile('Choose a browser').then((path) => {
              if (path) onChange({ ...browser, command: path })
            })
          }}
          style={smallBtn}
        >
          Browse…
        </button>
      </div>
      <input
        style={inputStyle}
        placeholder="--incognito"
        value={argsText}
        onChange={(e) => {
          setArgsText(e.target.value)
          onChange({ ...browser, args: parseArgs(e.target.value) })
        }}
      />
    </div>
  )
}

export function SettingsView(): React.JSX.Element | null {
  const show = useStore((s) => s.showSettings)
  const setShow = useStore((s) => s.setShowSettings)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const [draft, setDraft] = useState<Settings | null>(settings)
  const [shortcutStatus, setShortcutStatus] = useState<{ accelerator: string; registered: boolean } | null>(null)

  useEffect(() => {
    if (show) {
      setDraft(settings)
      void window.terminator.getGlobalShortcutStatus().then(setShortcutStatus)
    }
  }, [show, settings])

  // Picking a theme applies it immediately so the swatch grid is a real preview;
  // closing without saving puts the saved one back.
  useEffect(() => {
    if (show || !settings) return
    applyThemeFromSettings(settings)
  }, [show, settings])

  if (!show || !draft) return null

  const patch = (p: Partial<Settings>) => setDraft({ ...draft, ...p })
  const save = async () => {
    const result = await window.terminator.updateSettings(draft)
    setSettings(result)
    setShow(false)
  }

  const patchLinks = (p: Partial<Settings['links']>) => patch({ links: { ...draft.links, ...p } })
  const defaultBrowserName = draft.links?.browsers.find(
    (b) => b.id === draft.links.defaultBrowserId,
  )?.name

  const toggleTrigger = (t: NotifType) => {
    const cur = draft.notifications.triggerOn
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]
    patch({ notifications: { ...draft.notifications, triggerOn: next } })
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
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
          width: 540,
          maxWidth: '94vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: C.panel,
          border: `1px solid ${C.border3}`,
          borderRadius: 14,
          boxShadow: C.shadowModal,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '18px 20px 14px' }}>
          <span style={{ display: 'flex', color: C.accent }}>
            <Icon name="settings" size={16} />
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.textMax }}>Settings</span>
          <button
            onClick={() => setShow(false)}
            style={{ marginLeft: 'auto', display: 'flex', width: sz(26), height: sz(26), alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer' }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>

        <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="CLAUDE COMMAND" hint="Run for a normal Claude session. The app appends --session-id / --resume / --settings.">
            <input style={inputStyle} value={draft.modes.normal.command} onChange={(e) => patch({ modes: { ...draft.modes, normal: { ...draft.modes.normal, command: e.target.value } } })} />
          </Field>
          <Field label="CLAUDE READ-ONLY COMMAND" hint={'Must forward appended args (e.g. exec claude --some-flag "$@").'}>
            <input style={inputStyle} value={draft.modes.readonly.command} onChange={(e) => patch({ modes: { ...draft.modes, readonly: { ...draft.modes.readonly, command: e.target.value } } })} />
          </Field>
          <Field label="DEFAULT SHELL" hint="Used for plain terminals and to resolve commands.">
            <input style={inputStyle} value={draft.defaultShell} onChange={(e) => patch({ defaultShell: e.target.value })} />
          </Field>
          <Field label="GIT GUI COMMAND" hint="Launched with a session's folder by the git button. App never merges.">
            <input style={inputStyle} value={draft.gitGuiCommand} onChange={(e) => patch({ gitGuiCommand: e.target.value })} />
          </Field>
          <Field label="WORKTREES ROOT" hint="Where new git worktrees are created.">
            <input style={inputStyle} value={draft.worktreesRoot} onChange={(e) => patch({ worktreesRoot: e.target.value })} />
          </Field>

          <div style={{ height: 1, background: C.hair, margin: '2px 0' }} />

          <Field label="THEME" hint="Applies to the app, the terminal panes (including ANSI colours) and the file editor. Individual colours can be overridden with a customTheme block in settings.json.">
            <ThemePicker
              value={draft.theme}
              onPick={(theme) => {
                patch({ theme })
                applyThemeFromSettings({ theme, customTheme: draft.customTheme })
              }}
            />
          </Field>

          <Field label="TERMINAL FONT" hint="Font family for the terminal panes (the app chrome uses JetBrains Mono).">
            <input
              style={inputStyle}
              list="term-fonts"
              value={draft.terminalFont}
              onChange={(e) => patch({ terminalFont: e.target.value })}
            />
            <datalist id="term-fonts">
              <option value="'JetBrains Mono', monospace" />
              <option value="'Fira Code', monospace" />
              <option value="'Cascadia Code', monospace" />
              <option value="'Source Code Pro', monospace" />
              <option value="Menlo, monospace" />
              <option value="Consolas, monospace" />
              <option value="'Ubuntu Mono', monospace" />
              <option value="monospace" />
            </datalist>
          </Field>
          <Field label="FONT SIZE" hint="Scales the whole interface — sidebar, tabs, and terminals. 14 = default.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="range"
                min={9}
                max={26}
                step={1}
                value={draft.fontSize}
                onChange={(e) => patch({ fontSize: Number(e.target.value) || draft.fontSize })}
                style={{ flex: 1, accentColor: C.accent }}
              />
              <input
                type="number"
                min={9}
                max={26}
                style={{ ...inputStyle, width: 70, flex: 'none' }}
                value={draft.fontSize}
                onChange={(e) => patch({ fontSize: Number(e.target.value) || draft.fontSize })}
              />
            </div>
          </Field>
          <Field label="ICON SIZE" hint="Scales buttons and icons only, on top of the interface size. 100 = default.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="range"
                min={80}
                max={160}
                step={10}
                value={draft.iconScale}
                onChange={(e) => patch({ iconScale: Number(e.target.value) || draft.iconScale })}
                style={{ flex: 1, accentColor: C.accent }}
              />
              <input
                type="number"
                min={80}
                max={160}
                step={10}
                style={{ ...inputStyle, width: 70, flex: 'none' }}
                value={draft.iconScale}
                onChange={(e) => patch({ iconScale: Number(e.target.value) || draft.iconScale })}
              />
            </div>
          </Field>
          <Field label="SIDEBAR POSITION" hint="Which side of the window the session sidebar sits on.">
            <div style={{ display: 'flex', gap: 8 }}>
              {(['left', 'right'] as const).map((side) => {
                const on = (draft.sidebarSide ?? 'left') === side
                return (
                  <button
                    key={side}
                    onClick={() => patch({ sidebarSide: side })}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: `1px solid ${on ? C.accentBorder : C.border2}`,
                      background: on ? accentA(0.12) : 'transparent',
                      color: on ? C.accentSoft : C.muted,
                      font: 'inherit',
                      fontSize: 12.5,
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                    }}
                  >
                    {side}
                  </button>
                )
              })}
            </div>
          </Field>
          <Field
            label="GLOBAL SHOW/HIDE SHORTCUT"
            hint="System-wide hotkey to minimize/restore the window, even when the app isn't focused. Click to record, Esc to cancel, Clear to disable. Applies after Save."
          >
            <ShortcutRecorder
              value={draft.globalToggleShortcut ?? ''}
              onChange={(accel) => patch({ globalToggleShortcut: accel })}
            />
            {shortcutStatus && (
              <div style={{ fontSize: 10.5, marginTop: 6, color: shortcutStatus.registered ? STATUS_COLORS.idle : C.dim }}>
                {shortcutStatus.accelerator
                  ? shortcutStatus.registered
                    ? `✓ Active: ${shortcutStatus.accelerator}`
                    : `Not registered: ${shortcutStatus.accelerator} (the key may be in use)`
                  : 'Currently disabled'}
              </div>
            )}
          </Field>
          <Field
            label="OPEN NOTES SHORTCUT"
            hint="In-app hotkey to toggle the Notes overlay. Click to record, Esc to cancel, Clear to disable. Applies after Save."
          >
            <ShortcutRecorder
              value={draft.notesShortcut ?? ''}
              onChange={(accel) => patch({ notesShortcut: accel })}
            />
          </Field>

          <Field
            label="ATTACHMENT READS"
            hint="Pasted images are saved in the app's own folder, outside your repos — which puts them outside Claude's working directory. Pre-approved adds that one folder to each Claude session's allowed directories, so reading a pasted screenshot never stops to ask. Dropped files are read from where they live and follow your normal permission rules either way."
          >
            <div style={{ display: 'flex', gap: 8 }}>
              {([true, false] as const).map((val) => {
                const on = (draft.attachments?.allowClaudeRead ?? true) === val
                return (
                  <button
                    key={String(val)}
                    onClick={() => patch({ attachments: { ...draft.attachments, allowClaudeRead: val } })}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: `1px solid ${on ? C.accentBorder : C.border2}`,
                      background: on ? accentA(0.12) : 'transparent',
                      color: on ? C.accentSoft : C.muted,
                      font: 'inherit',
                      fontSize: 12.5,
                      cursor: 'pointer',
                    }}
                  >
                    {val ? 'Pre-approved' : 'Ask each time'}
                  </button>
                )
              })}
            </div>
          </Field>
          <Field label="KEEP PASTED IMAGES FOR" hint="Days before a saved paste is deleted, checked at startup. 0 keeps them forever. Dropped files are never touched.">
            <input
              type="number"
              min={0}
              max={365}
              style={{ ...inputStyle, width: 90 }}
              value={draft.attachments?.keepDays ?? 7}
              onChange={(e) =>
                patch({ attachments: { ...draft.attachments, keepDays: Math.max(0, Number(e.target.value) || 0) } })
              }
            />
          </Field>

          <div style={{ height: 1, background: C.hair, margin: '2px 0' }} />

          <Field
            label="LINKS IN TERMINAL OUTPUT"
            hint="Underlines http and https links in a pane and opens them on click. Hovering one shows where it goes; selecting text over a link never opens it. Only http and https are ever opened — terminal output can't launch anything else."
          >
            <Choice
              value={draft.links?.enabled ?? true}
              onPick={(enabled) => patchLinks({ enabled })}
              options={[
                { value: true, label: 'Clickable' },
                { value: false, label: 'Plain text' },
              ]}
            />
          </Field>

          <Field
            label="BROWSERS FOR LINKS"
            hint="The program and its arguments are kept apart and handed straight to the process, so a path with spaces (Program Files) needs no quoting. A plain click uses the default; right-click a link for the rest. With no browser here, links open in your OS default."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(draft.links?.browsers ?? []).map((b, i) => (
                <BrowserRow
                  key={b.id}
                  browser={b}
                  isDefault={draft.links.defaultBrowserId === b.id}
                  onChange={(next) => {
                    const browsers = draft.links.browsers.slice()
                    browsers[i] = next
                    patchLinks({ browsers })
                  }}
                  onMakeDefault={() =>
                    patchLinks({
                      // Clicking the default again hands links back to the OS.
                      defaultBrowserId: draft.links.defaultBrowserId === b.id ? '' : b.id,
                    })
                  }
                  onRemove={() => {
                    const browsers = draft.links.browsers.filter((x) => x.id !== b.id)
                    patchLinks({
                      browsers,
                      defaultBrowserId:
                        draft.links.defaultBrowserId === b.id ? '' : draft.links.defaultBrowserId,
                    })
                  }}
                />
              ))}
              <button
                onClick={() =>
                  patchLinks({
                    browsers: [
                      ...(draft.links?.browsers ?? []),
                      { id: newBrowserId(), name: 'New browser', command: '', args: [] },
                    ],
                  })
                }
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: `1px dashed ${C.border3}`,
                  background: 'transparent',
                  color: C.muted,
                  font: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                + Add browser
              </button>
              <div style={{ fontSize: 10.5, color: C.dim }}>
                {defaultBrowserName
                  ? `A plain click opens ${defaultBrowserName}.`
                  : 'A plain click opens your OS default browser.'}
              </div>
            </div>
          </Field>

          <Field
            label="FILE PATHS IN OUTPUT"
            hint="Also linkify paths a session prints (src/app.ts:42 jumps to the line). They open in an Editor pane for that project, and only ever paths that exist inside the session's own folder."
          >
            <Choice
              value={draft.links?.openFilePaths ?? true}
              onPick={(openFilePaths) => patchLinks({ openFilePaths })}
              options={[
                { value: true, label: 'Open in editor' },
                { value: false, label: 'Leave as text' },
              ]}
            />
          </Field>

          <Field label="NOTIFICATION COMMAND" hint="Run on each notification, via your shell. Receives the event as JSON on stdin and TERMINATOR_* env vars. Leave blank to disable.">
            <input style={inputStyle} placeholder="python3 ~/notify.py" value={draft.notifications.command} onChange={(e) => patch({ notifications: { ...draft.notifications, command: e.target.value } })} />
          </Field>
          <Field label="RUN COMMAND ON">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {NOTIF_TYPES.map((t) => {
                const on = draft.notifications.triggerOn.includes(t)
                return (
                  <button
                    key={t}
                    onClick={() => toggleTrigger(t)}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 7,
                      border: `1px solid ${on ? C.accentBorder : C.border2}`,
                      background: on ? accentA(0.12) : 'transparent',
                      color: on ? C.accentSoft : C.muted,
                      font: 'inherit',
                      fontSize: 12,
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                    }}
                  >
                    {t}
                  </button>
                )
              })}
            </div>
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '18px 20px 20px', marginTop: 6 }}>
          <button onClick={() => setShow(false)} style={{ padding: '10px 18px', background: 'transparent', border: `1px solid ${C.border3}`, borderRadius: 9, color: C.textBtn, font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={save} style={{ padding: '10px 20px', background: C.accent, border: 'none', borderRadius: 9, color: C.accentText, font: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
            Save settings
          </button>
        </div>
      </div>
    </div>
  )
}
