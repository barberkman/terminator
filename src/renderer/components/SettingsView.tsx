import { useEffect, useState } from 'react'
import type { BrowserOption, EditorOption, NotifType, Settings } from '../../shared/types'
import { formatArgs, parseArgs } from '../../shared/args'
import { importTheme, newThemeId, resolveTheme, snapshotSeed } from '../../shared/themes'
import { C, STATUS_COLORS, accentA, sz } from '../theme'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import { ThemePicker } from './ThemePicker'
import { Choice, Field, Section, inputStyle, smallBtn } from './controls'
import { applyThemeFromSettings } from '../theme-apply'
import { freeName, upsert, writeThemes } from '../themeActions'
import { eventToAccelerator } from '../shortcuts'

const NOTIF_TYPES: NotifType[] = ['waiting', 'finished', 'error', 'exited']

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

/** Argument lines that work, for the editors people are most likely to reach for. */
const EDITOR_EXAMPLES: [string, string][] = [
  ['VS Code', '-g {path}:{line}'],
  ['Sublime', '{path}:{line}'],
  ['Notepad++', '-n{line}'],
  ['gvim', '+{line}'],
  ['Zed', '{path}:{line}'],
]

/**
 * The one external editor a clicked file path opens in. Same command/args split
 * as a browser (so `C:\Program Files\…` needs no quoting), plus the placeholders
 * that let each editor's own way of naming a line work.
 */
function EditorRow({
  editor,
  onChange,
}: {
  editor: EditorOption
  onChange: (e: EditorOption) => void
}): React.JSX.Element {
  const [argsText, setArgsText] = useState(() => formatArgs(editor.args))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ ...inputStyle, flex: 1 }}
          placeholder="/usr/bin/code   or   C:\Program Files\Microsoft VS Code\Code.exe"
          value={editor.command}
          onChange={(e) => onChange({ ...editor, command: e.target.value })}
        />
        <button
          onClick={() => {
            void window.terminator.pickFile('Choose an editor').then((path) => {
              if (path) onChange({ ...editor, command: path })
            })
          }}
          style={smallBtn}
        >
          Browse…
        </button>
        {!!editor.command.trim() && (
          <button
            onClick={() => onChange({ command: '', args: [] })}
            title="Go back to opening file paths in an in-app Editor pane"
            style={{ ...smallBtn, color: C.danger }}
          >
            Clear
          </button>
        )}
      </div>
      <input
        style={inputStyle}
        placeholder="-g {path}:{line}"
        value={argsText}
        onChange={(e) => {
          setArgsText(e.target.value)
          onChange({ ...editor, args: parseArgs(e.target.value) })
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
  const customThemes = useStore((s) => s.customThemes)
  const setThemeEditorFor = useStore((s) => s.setThemeEditorFor)
  const [draft, setDraft] = useState<Settings | null>(settings)
  const [shortcutStatus, setShortcutStatus] = useState<{ accelerator: string; registered: boolean } | null>(null)
  // null when the import sheet is shut; the pasted text while it's open.
  const [importText, setImportText] = useState<string | null>(null)
  const [importError, setImportError] = useState('')

  // Re-seeded when the panel opens, and deliberately not when `settings` changes
  // underneath: duplicating a theme writes settings while the panel is up, and
  // re-seeding there would throw away whatever the user was half-way through
  // typing in one of the command boxes.
  useEffect(() => {
    if (show) {
      setDraft(settings)
      setImportText(null)
      setImportError('')
      void window.terminator.getGlobalShortcutStatus().then(setShortcutStatus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show])

  // Picking a theme applies it immediately so the swatch grid is a real preview;
  // closing without saving puts the saved one back. Anything that makes a theme
  // of the user's own persists the selection as it goes, so there is nothing of
  // theirs for this to revert.
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
  // Same name the tooltip and the right-click menu show: the executable's basename.
  const editorLabel = (draft.links?.editor?.command ?? '')
    .trim()
    .split(/[/\\]/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.(exe|cmd|bat|com)$/i, '')

  const toggleTrigger = (t: NotifType) => {
    const cur = draft.notifications.triggerOn
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]
    patch({ notifications: { ...draft.notifications, triggerOn: next } })
  }

  // ---- sections ----
  // Absent means collapsed, so a first run opens as a short list of headings
  // rather than the scroll this replaced. Toggling persists on the spot: which
  // sections you left open isn't an edit, so Cancel has no business undoing it.
  const isOpen = (id: string): boolean => draft.settingsOpen?.[id] ?? false
  const toggleSection = (id: string) => {
    const settingsOpen = { ...draft.settingsOpen, [id]: !isOpen(id) }
    patch({ settingsOpen })
    void window.terminator.updateSettings({ settingsOpen }).then(setSettings)
  }
  const section = (id: string, label: string, summary: React.ReactNode, children: React.ReactNode, actions?: React.ReactNode) => (
    <Section label={label} summary={summary} actions={actions} open={isOpen(id)} onToggle={() => toggleSection(id)}>
      {children}
    </Section>
  )

  // ---- themes ----
  const active = resolveTheme(draft.theme, draft.customTheme)
  const pickTheme = (theme: string) => {
    patch({ theme })
    applyThemeFromSettings({ theme, customTheme: draft.customTheme })
  }
  /**
   * Selecting one of the user's own themes is persisted rather than left in the
   * draft: they've just made or opened a theme, and having Cancel quietly put the
   * old one back would read as losing the work rather than discarding a preview.
   */
  const selectAndEdit = async (id: string) => {
    patch({ theme: id })
    applyThemeFromSettings({ theme: id, customTheme: draft.customTheme })
    setSettings(await window.terminator.updateSettings({ theme: id }))
    setThemeEditorFor(id)
  }
  const addTheme = async (seed: Parameters<typeof upsert>[1]) => {
    await writeThemes(upsert(customThemes, seed))
    await selectAndEdit(seed.id)
  }
  const duplicate = () =>
    void addTheme(
      snapshotSeed(
        draft.theme,
        draft.customTheme,
        freeName(active.name, customThemes.map((t) => t.name)),
        newThemeId(),
      ),
    )
  const runImport = () => {
    const result = importTheme(importText ?? '')
    if (!result.ok) {
      setImportError(result.reason)
      return
    }
    setImportText(null)
    setImportError('')
    void addTheme(result.seed)
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

        <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column' }}>
          {section(
            'theme',
            'THEME',
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: active.accent,
                  border: `1px solid ${C.border3}`,
                  flex: 'none',
                }}
              />
              {active.name}
            </span>,
            <>
              <Field hint="Applies to the app, the terminal panes (including ANSI colours) and the file editor. Duplicate one to get a theme of your own — copies are editable, the built-ins are not." label="PICK A THEME">
                <ThemePicker value={draft.theme} onPick={pickTheme} onEdit={(id) => void selectAndEdit(id)} />
              </Field>
              {importText !== null && (
                <Field label="PASTE A THEME" hint="Our own export, or any JSON object of theme colours — a published palette's ansi block on its own is enough. It always lands as a new theme of yours.">
                  <textarea
                    autoFocus
                    value={importText}
                    onChange={(e) => {
                      setImportText(e.target.value)
                      setImportError('')
                    }}
                    placeholder={'{ "name": "Ayu Mirage", "bg": "#1f2430", … }'}
                    style={{ ...inputStyle, height: 120, resize: 'vertical', fontSize: 11.5, lineHeight: 1.5 }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                    <button onClick={() => setImportText(window.terminator.clipboardRead())} style={smallBtn}>
                      Paste from clipboard
                    </button>
                    <button
                      onClick={runImport}
                      style={{ ...smallBtn, borderColor: C.accentBorder, color: C.accentSoft, background: accentA(0.12) }}
                    >
                      Add theme
                    </button>
                    <button onClick={() => { setImportText(null); setImportError('') }} style={smallBtn}>
                      Cancel
                    </button>
                    {importError && <span style={{ fontSize: 10.5, color: C.danger }}>{importError}</span>}
                  </div>
                </Field>
              )}
            </>,
            <>
              <button onClick={duplicate} title="Copy the theme you're looking at, overrides and all, and edit the copy" style={smallBtn}>
                Duplicate
              </button>
              <button
                onClick={() => {
                  const opening = importText === null
                  setImportText(opening ? '' : null)
                  setImportError('')
                  // The paste box lives in the section body, so opening it from a
                  // collapsed header has to open the section too.
                  if (opening && !isOpen('theme')) toggleSection('theme')
                }}
                style={smallBtn}
              >
                Import…
              </button>
            </>,
          )}

          {section('commands', 'COMMANDS AND PATHS', draft.modes.normal.command, (
            <>
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
            </>
          ))}

          {section('appearance', 'APPEARANCE', `${draft.fontSize} · ${draft.iconScale}% · sidebar ${draft.sidebarSide ?? 'left'}`, (
            <>
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
                <Choice
                  value={draft.sidebarSide ?? 'left'}
                  onPick={(sidebarSide) => patch({ sidebarSide })}
                  options={[
                    { value: 'left' as const, label: 'Left' },
                    { value: 'right' as const, label: 'Right' },
                  ]}
                />
              </Field>
            </>
          ))}

          {section('shortcuts', 'SHORTCUTS', draft.globalToggleShortcut || 'none set', (
            <>
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
            </>
          ))}

          {section(
            'attachments',
            'IMAGES AND FILES',
            `${(draft.attachments?.allowClaudeRead ?? true) ? 'Pre-approved' : 'Ask each time'} · ${
              (draft.attachments?.keepDays ?? 7) === 0 ? 'kept forever' : `${draft.attachments?.keepDays ?? 7} days`
            }`,
            (
              <>
                <Field
                  label="ATTACHMENT READS"
                  hint="Pasted images are saved in the app's own folder, outside your repos — which puts them outside Claude's working directory. Pre-approved adds that one folder to each Claude session's allowed directories, so reading a pasted screenshot never stops to ask. Dropped files are read from where they live and follow your normal permission rules either way."
                >
                  <Choice
                    value={draft.attachments?.allowClaudeRead ?? true}
                    onPick={(allowClaudeRead) => patch({ attachments: { ...draft.attachments, allowClaudeRead } })}
                    options={[
                      { value: true, label: 'Pre-approved' },
                      { value: false, label: 'Ask each time' },
                    ]}
                  />
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
              </>
            ),
          )}

          {section(
            'links',
            'LINKS AND FILE PATHS',
            `${(draft.links?.enabled ?? true) ? 'Clickable' : 'Plain text'} · ${
              (draft.links?.browsers ?? []).length
            } browser${(draft.links?.browsers ?? []).length === 1 ? '' : 's'}`,
            (
              <>
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
                  hint="Also linkify paths a session prints (src/app.ts:42 jumps to the line), and only ever paths that exist inside the session's own folder."
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

                <Field
                  label="EXTERNAL EDITOR"
                  hint="The program a clicked file path opens in. Program and arguments are kept apart and handed straight to the process, so a path with spaces needs no quoting. In the arguments, {path}, {line} and {column} are filled in where you put them — an argument mentioning {line} is dropped when the path had no line number, and with no {path} anywhere the file is added at the end. Leave the program blank to open file paths in an in-app Editor pane instead."
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <EditorRow
                      editor={draft.links?.editor ?? { command: '', args: [] }}
                      onChange={(editor) => patchLinks({ editor })}
                    />
                    <div style={{ fontSize: 10.5, color: C.dim }}>
                      {editorLabel
                        ? `A clicked path opens ${editorLabel}. Right-click one for an editor pane instead.`
                        : 'A clicked path opens an in-app Editor pane covering that project.'}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 14px', fontSize: 10.5, color: C.faint2 }}>
                      {EDITOR_EXAMPLES.map(([name, args]) => (
                        <span key={name} style={{ whiteSpace: 'nowrap' }}>
                          {name} <code style={{ color: C.dim }}>{args}</code>
                        </span>
                      ))}
                    </div>
                  </div>
                </Field>
              </>
            ),
          )}

          {section(
            'notifications',
            'NOTIFICATIONS',
            draft.notifications.command ? draft.notifications.triggerOn.join(', ') || 'no triggers' : 'no command',
            (
              <>
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
              </>
            ),
          )}
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
