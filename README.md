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

## Settings

Settings live in a JSON file in the app's user-data directory (editable in-app via the gear
icon, or on disk):

- `modes.normal.command` / `modes.readonly.command` — the Claude commands (defaults `claude`,
  `claude-readonly`). The app appends `--session-id` / `--resume` / `--settings`, so a custom
  read-only command must forward appended args (e.g. `exec claude --permission-mode plan "$@"`).
- `defaultShell`, `gitGuiCommand`, `worktreesRoot`, `projects`.
- `notifications` — see below.

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
The visual design lives in [`design/reference.html`](design/reference.html).
