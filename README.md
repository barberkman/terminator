# Terminator

A personal, local desktop app (Windows / macOS / Linux) for running and supervising
multiple terminal sessions from one window — built primarily for keeping an eye on several
**Claude Code** sessions at once, with plain shells as first-class citizens too.

The product priority is a reliable **"which session needs me"** signal: when a Claude session
starts waiting for your input, its sidebar entry and tab light up and you get notified — even
while you're focused on another session.

## Run it

```bash
npm install
npm run dev      # launches the app with hot-reload
```

Requires Node 18+ (developed on Node 24) and Git. No other native toolchain — the PTY layer
([`@lydell/node-pty`](https://www.npmjs.com/package/@lydell/node-pty)) ships prebuilt N-API
binaries, so there's no compile/rebuild step.

```bash
npm run build      # production build into out/
npm start          # run the production build
npm run typecheck  # tsc, no emit
```

## What it does

- **Sidebar** lists every session grouped by project, each with a live status dot.
- **Main area** shows open sessions as live terminal panes, with a layout switcher for viewing
  **1 / 2 / 4** sessions at once. Off-screen sessions keep running.
- **New session**: pick a folder, name it, choose a type — **Claude**, **Claude (read-only)**,
  or **Terminal** — and optionally create a **git worktree** on a new branch.
- **Status** updates live. Claude sessions report rich states (working / waiting / idle /
  finished / error) via Claude Code hooks; plain terminals show running / idle / exited.
- **Mode switch**: one click toggles a Claude session between normal and read-only, **continuing
  the same conversation** (it relaunches with `--resume`).
- **Branch a conversation**: fork a Claude session from any earlier prompt into a sibling
  session. Both keep running, nested in the sidebar. See below.
- **Images and files**: paste a screenshot straight into a Claude session, or drop files and
  folders onto a pane. See below.
- **Open in git GUI**: launches your configured git tool on the session's folder for manual
  merging. The app never merges; after you close a worktree session it offers to remove the
  worktree.

## How Claude state detection works

When the app starts a Claude session it runs your configured command (default `claude`) through
your shell, appending `--session-id <uuid>` and a per-session `--settings` file. That settings
file injects **hooks** and a **statusLine** that report back to a loopback HTTP server
(127.0.0.1, random port, bearer-token auth) the app runs:

- Hooks → state transitions: `UserPromptSubmit`/`PreToolUse`/`PostToolUse` → **working**,
  `Notification`/`PermissionRequest`/`Elicitation` → **waiting** (the "needs me" signal),
  `Stop` → **idle/finished**, abnormal exit → **error**.
- statusLine → the model / effort / context% / cost / usage shown in the pane header and footer.

Because the app forces `--session-id`, every hook payload's `session_id` maps back to the exact
session — so two Claude sessions in the *same folder* are tracked independently. Your own
`~/.claude` and project hooks are read and merged in, so they keep firing.

## Branching a conversation

The branch button (pane header, or a session row on hover) opens the session's prompts with a
cut line you move between them: everything above comes along, everything below stays with the
parent. Confirm and you get a **new session** — not a rewind — so the original conversation
keeps running beside it, each with its own status dot, metrics and pane.

- The branch is nested under its parent in the sidebar with a `⑂ n` count you can fold away.
  A folded branch that starts waiting still lights its parent's badge, so the "needs me"
  signal never hides.
- Cutting *above* a prompt means you want to ask that one differently: its text is typed into
  the new session's input box, unsent, ready to edit.
- Optionally the branch gets its own **git worktree**, which is what you want when the parent
  is a live normal-mode session — otherwise both Claudes edit the same files.
- Removing a parent doesn't take its branches with it; they move up a level and keep the
  `⑂ from <name>` label.

Under the hood a branch is a **seeded transcript**. Claude keeps one JSONL per session at
`~/.claude/projects/<cwd-encoded>/<session-id>.jsonl`; the app copies the parent's file up to
the cut under a new session id and lets the normal launch path resume it. `--fork-session`
would be the obvious alternative, but it mints a random session id, and every hook and
statusLine payload is matched to a session *by* its id — so the app has to choose the id
itself. The parent's file is only ever read, never modified.

## Images and files

Two ways to hand a session something to look at, and both end the same way: the file's **path**
is typed into the session — into Claude's prompt box, which reads it from there, or at a shell's
prompt, which is what dropping a file on any other terminal does.

- **Paste** — take a screenshot (`Win+Shift+S` on Windows), click a pane, **Ctrl/Cmd+V**. The
  bitmap is written out as a PNG and referenced. With no image on the clipboard, Ctrl/Cmd+V
  pastes text exactly as it always did; when the clipboard holds *both*, the image wins and
  **Ctrl/Cmd+Shift+V** is the way to the text.
- **Drag and drop** — drop one file, several at once, or a folder onto a pane; the pane outlines
  itself while you drag over it. **Dropped files stay where they are** — referenced in place,
  never copied, moved or duplicated — and a folder is referenced as a path rather than expanded.
  (Something dragged out of a browser has no path of its own, so that one is written out like a
  paste.) Dropping on a pane that can't take it — an editor pane, an empty one — says so instead
  of doing nothing.

Into a Claude pane it goes as a **bracketed paste**, so it lands at the cursor: whatever you had
already typed survives, and nothing is submitted for you. Into a shell it's the plain
shell-quoted path, with no newline, so nothing runs. Attach several things one after another and
they queue up in the same prompt.

Every attach raises a toast naming what landed — with a thumbnail for an image, since a terminal
can't show you one — and anything that *can't* be attached raises the reason instead of failing
quietly.

Pasted images are written to `attachments/` inside the app's user-data directory — never into a
project, so they can't show up in a `git status` — and pruned at startup once they pass
Settings → **KEEP PASTED IMAGES FOR** (7 days by default, 0 to keep them). The folder is also
capped by file count and total size. Dropped files are never touched by the pruner: they aren't
the app's to delete.

Because that folder sits outside the session's working directory, Claude would normally stop and
ask before reading a pasted screenshot. Settings → **ATTACHMENT READS** is *Pre-approved* by
default, which adds that one folder to `permissions.additionalDirectories` in the per-session
`--settings` file, so it doesn't. Set it to *Ask each time* to get the prompt back. Your own
`permissions` (from `~/.claude/settings.json` and the project's settings) are read and merged
into that file first — the same treatment your hooks already get — so nothing of yours is
displaced by ours.

## Keyboard & mouse

In a terminal pane:

- **Shift+Enter** (Claude sessions) — new line in the prompt instead of submitting it. The pane
  sends `ESC`+`CR`, the same bytes as **Alt+Enter** and what Claude's `/terminal-setup` makes
  other terminals send. Plain **Enter** still submits. Shell panes are untouched, so there
  Shift+Enter still runs the command.
- **Right-click** — copies the selection and clears the highlight. With nothing selected the
  click passes through to the program in the pane (no context menu either way).
- **Ctrl/Cmd+C** — copies the selection; with nothing selected it sends `^C` (interrupt).
- **Ctrl/Cmd+V** — pastes: an image if the clipboard holds one, otherwise text.
- **Ctrl/Cmd+Shift+V** — pastes text, never the image. The way out when the clipboard holds both.
- **Drop a file** on a pane to hand it to that session.

Elsewhere in the app: **Ctrl/Cmd+N** new session, **Ctrl/Cmd+B** toggle sidebar, **Alt+1..9**
jump to a session, **Esc** closes the top modal. The global show/hide hotkey (default `F12`)
and the notes hotkey (default `Ctrl/Cmd+Shift+N`) are configurable in Settings.

## Settings

Settings live in a JSON file in the app's user-data directory (editable in-app via the gear
icon, or on disk):

- `modes.normal.command` / `modes.readonly.command` — the Claude commands (defaults `claude`,
  `claude-readonly`). The app appends `--session-id` / `--resume` / `--settings`, so a custom
  read-only command must forward appended args (e.g. `exec claude --permission-mode plan "$@"`).
- `defaultShell`, `gitGuiCommand`, `worktreesRoot`, `projects`.
- `theme` — the active colour theme (see below), and `customTheme` for per-token overrides.
- `notifications` — see below.
- `attachments.allowClaudeRead` / `attachments.keepDays` — see **Images and files** above.

## Themes

Settings → **THEME** is a grid of swatches, each painted in its own colours. Picking one applies
it immediately — to the app chrome, the terminal panes (background, cursor, selection **and the
16 ANSI colours**, so Claude's TUI takes on the theme) and the built-in file editor including
its syntax colours. Nothing needs a restart, and terminals that are open — even the ones parked
off-screen — repaint in place.

- **Dark** — Terminator (the default), Darcula, One Dark, Dracula, Gruvbox Dark, Nord,
  Solarized Dark.
- **Light** — Solarized Light, GitHub Light.
- **Reading** — the Apple Books set: Original, Quiet, Paper, Bold, Calm, Focus. *Paper* is the
  warm cream-and-ink page, with the faint grain behind the chrome (panes stay flat, so nothing
  interferes with glyph rendering); *Bold* also raises the chrome's font weight.

Themes live in [`src/shared/themes.ts`](src/shared/themes.ts). Each is a compact seed — a
background, two text anchors, a few accents, and the terminal/editor palettes — from which the
six surface shades and the eleven-step text ramp are derived, so adding one is about 25 lines.
The built palette is published as CSS custom properties (`--c-bg`, `--c-ink-rgb`, …) that the
whole renderer reads, and handed to xterm and CodeMirror as literal colours, which is what those
two need.

To adjust a single colour without writing a theme, add a `customTheme` block to `settings.json`:

```json
{ "theme": "nord", "customTheme": { "accent": "#00b0ff", "bg": "#101216" } }
```

It overrides tokens of the selected theme by name (any surface, ramp step, `accent`,
`accentSoft`, `accentText`, `danger`, `kindIcon` or `shadow`). Values must be hex; anything else
is ignored rather than applied, so a typo can't blank the UI.

## Notifications

The built-in notification surface is **in-app only**: a type-coloured toast (with an "Open"
jump button) plus a highlight on the session's sidebar row.

For anything else — desktop notifications, sound, a phone push — configure a **notification
command** that the app runs on each notification, through your shell. It receives the event as
**JSON on stdin** and as `TERMINATOR_*` environment variables, and can branch on the type:

- `TERMINATOR_NOTIF_TYPE` ∈ `waiting | finished | error | exited`
- `TERMINATOR_SESSION_NAME`, `TERMINATOR_PROJECT`, `TERMINATOR_BRANCH`, `TERMINATOR_STATUS`,
  `TERMINATOR_KIND`, `TERMINATOR_MODE`, `TERMINATOR_CWD`, `TERMINATOR_MESSAGE`

Configure which types fire it via `notifications.triggerOn` (default `["waiting","error"]`) and
optional per-type overrides via `notifications.perType`. A runnable example is in
[`examples/notify.py`](examples/notify.py).

## Tech

Electron + React + Vite (electron-vite), `@xterm/xterm` for the terminals, `@lydell/node-pty`
for the PTYs. The main process owns session state, PTYs, the hook/statusLine server, settings,
and persistence; the renderer mirrors session metadata and owns the keep-alive xterm instances.
The visual design lives in [`design/reference.html`](design/reference.html) — a static mockup of
the default theme, not wired into the build.
