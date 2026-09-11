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
  **Right-click** a session for everything you can do to it — rename, start/stop, branch,
  folders — whether or not it's open in a pane. See below.
- **Main area** shows open sessions as live terminal panes, with a layout switcher for viewing
  **1 / 2 / 4** sessions at once. Off-screen sessions keep running.
- **New session**: pick a folder, name it, choose a type — **Claude**, **Claude (read-only)**,
  or **Terminal** — and optionally create a **git worktree** on a new branch.
- **Status** updates live. Claude sessions report rich states (working / waiting / idle /
  finished / error) via Claude Code hooks; plain terminals show running / idle / exited.
- **Mode switch**: one click toggles a Claude session between normal and read-only, **continuing
  the same conversation** (it relaunches with `--resume`).
- **Pick up where you left off**: sessions survive a restart, but come back not running. Turn
  the startup prompt on and each start offers them back in one dialog, every box ticked — untick
  the ones you don't want. Off by default. See below.
- **Read the conversation**: flip a Claude pane from the live terminal to its conversation as
  a document — Claude's answers rendered as markdown, with a copy button on every code block.
  See below.
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

- Hooks → state transitions. `UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`PreCompact` and the
  `SubagentStart`/`SubagentStop` pair → **working** (a subagent finishing leaves the turn
  running, so it never reads as finished). `PermissionRequest` and `Elicitation` → **waiting**,
  and `Notification` only when its `notification_type` is one that means Claude has actually
  stopped for you: `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`,
  `agent_needs_input`, `worker_permission_prompt`, `quota_auto_resume_stale`. The hook fires for
  a dozen other reasons that merely announce something completed, resolved or timed out, and
  none of those touch the status — in particular `idle_prompt` ("Claude is waiting for your
  input") is a ~60-second idle *timeout* raised after a turn has already ended, so it can raise
  an optional `idle` nudge but never the "needs me" signal. `Stop` → **idle/finished** and its
  separate failure counterpart `StopFailure` → **error** (with the reason, e.g. `rate_limit`);
  an abnormal process exit is still an error too.
- Hook payloads carry no timestamp or sequence number, and every hook is its own process posting
  its own request, so arrival order is not the order Claude emitted them. The reporter stamps
  each report with the moment Claude spawned it, and the app pairs that with `prompt_id` (which
  Claude holds constant across one prompt's events) to order them: a permission prompt that was
  raised before a turn ended can never drag the finished session back to **waiting**. The
  "needs me" highlight clears itself when the session leaves waiting — clicking the row is a way
  to dismiss it early, not the only way out.
- statusLine → the model / effort / context% / cost shown in the pane header, and the
  rate-limit usage in the footer. The 5-hour and weekly windows belong to the account, not
  to a session, so they're held once and shown whichever pane has focus: any running
  session refreshes them for all of them, they're kept across restarts, and the footer
  counts down to each reset on its own clock rather than asking Claude anything.

Because the app forces `--session-id`, every hook payload's `session_id` maps back to the exact
session — so two Claude sessions in the *same folder* are tracked independently. Your own
`~/.claude` and project hooks are read and merged in, so they keep firing.

## Session menus

**Right-click a session row** for the actions that apply to it. Everything in the pane header
is here too, so it reaches a session you haven't opened — including **Rename**, which used to
mean opening the session in a pane and double-clicking its title.

The menu is built per session rather than fixed and greyed out, so what you see is what you can
do. Claude-only entries (mode switch, branch) are absent on a terminal row; **Start** and
**Stop** are never both there; worktree entries only exist when there's a worktree; an editor
session — which has no process at all — has no Start/Stop/Relaunch. A terminal row's menu is
visibly shorter than a Claude row's, and whole groups disappear together rather than leaving
gaps.

- **Stop** ends a session's process and leaves the row alone — the one thing the app couldn't
  do before, where the only way out of a running session was deleting it. **Start** brings it
  back (resuming the conversation, for Claude), and **Relaunch** does both. Starting a session
  that isn't in a pane is fine: it runs off-screen and its output is waiting when you open it.
  **Relaunching at startup** (below) is the same Start, offered for everything at once.
- **New session here** starts one of the four types on the same project immediately — no dialog,
  no re-picking the folder. **More options…** opens the normal New Session dialog with the
  project already filled in, for when you want a name, a worktree or a branch.
- **Open in split** picks which pane it lands in, rather than the app choosing. It only appears
  when there's more than one split to choose between — and it's the only opening entry, since
  clicking the row already opens it.
- Destructive actions sit last, separated, and keep their confirmation. There's no **Close**:
  it only ever meant Remove, and now that Stop exists the pair that means something is **Stop**
  and **Remove**.

**When a session has a worktree** it points at two folders that are not interchangeable — the
worktree and the project it was cut from. Starting another Claude in the worktree means two
agents editing one working copy; starting a *terminal* there is exactly what you want, to run
tests on what Claude just wrote. So the menu never guesses: **New session here**, **Copy path**,
**Open folder** and **Open in git tool** each name the two folders and let you pick. With no
worktree that level isn't there and they're plain entries.

The same menu is on the **session tabs of the collapsed rail**, and **project group headers**
get a per-project one: a new session in that project, its Build/Run/Stop commands (only the ones
you've configured), the project folder, and collapse.

It's an in-app menu, not an OS one, so it follows your theme like everything else. Arrows and
Enter work, `→`/`←` open and leave submenus, typing jumps to an entry, and **Esc** closes one
level at a time — ahead of anything else Esc would have closed. Left-click-to-open and
drag-to-reorder are untouched.

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

## Reading a conversation

The **conversation button** in a Claude pane's header (or the pane's own **Terminal** button to
go back) swaps the live terminal for the same session read as a document: your prompts, Claude's
replies as rendered markdown, and **a copy button on every fenced code block**. No more
drag-selecting across wrapped terminal lines and getting the indentation back mangled.

- **The text is the real text.** It comes from the session's transcript — the JSONL Claude keeps
  per session, the same file the branch picker reads — not from the painted terminal. So a copied
  block has its original indentation, no wrapping artifacts, and nothing the TUI drew around it.
  It also means the view doesn't care what theme you're on or which Claude version drew the
  output.
- **The whole session, not the visible part.** The transcript goes back to the first message, so
  code from an hour ago is still there after it has scrolled out of the terminal's scrollback.
  A session that has exited still has its conversation: this reads back what a session did while
  you were looking elsewhere, which is most of what it's for.
- **Copy a whole message too.** Each exchange has **Copy prompt** and **Copy reply** — the reply
  being everything Claude wrote in prose that turn, as markdown. Inline `code` copies on click,
  like it does in Notes.
- **The working is folded away.** Tool calls are one line each — the command, the file, the
  pattern — opening to what they were given and what came back (long output collapses to its
  first lines, and copies in full). Thinking is one collapsed line. Subagent traffic stays behind
  the `Task` row that started it. Nothing is dumped at you raw.
- **It keeps up.** The view follows the session while it works, without a refresh. Scroll up to
  read and it stays where you put it, offering a **New messages** jump instead of yanking you to
  the bottom.
- **The terminal is still there.** It's an overlay, not a replacement: the pane's terminal stays
  running, the right size, underneath — switching back is instant and the session never notices.
  **Esc** from the conversation also returns to it.

Only Claude sessions have any of this. Plain terminals and editor panes are unchanged.

The renderer is the one the Notes preview uses (`src/renderer/markdown.tsx`), so a code block
copies the same way wherever you find it.

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

**The toast is the way back to the file.** For a single attachment the card is the only place its
path is ever shown, so it also opens it:

- **Click the card** — an image opens in whatever you view images with, a folder opens as a
  folder, and anything else opens in the editor from Settings → **EXTERNAL EDITOR** (the one
  clicked paths in output already use), or your default program when none is set.
- **Click the folder button**, beside the dismiss ×, to show it in Explorer with the file
  selected — Finder on macOS, your file manager elsewhere.
- **Right-click the card** for both, plus **Copy path**.

Pointing at a toast, or tabbing onto it, **pauses its countdown**, which picks up where it left
off when you leave — five seconds is no time at all to read a path and aim at a button. A card
held that way still goes after about half a minute, so a cursor parked in the corner can't leave
one sitting there. **Tab** reaches the folder and dismiss buttons; **Enter** on the card opens the
file.

A toast with nothing behind it — a failed attach, or a drop of several files at once, which names
them rather than pointing at one — is just a message: no folder button, and clicking it does
nothing. Nothing is greyed out; it simply isn't there. Only an attachment from *this* run of the
app opens this way: the card hands its path back and the main process checks it against the paths
it handed out, so nothing else opens however real it looks, and one that has since been moved or
pruned says so rather than opening whatever is there now.

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

## Links

A URL a session prints is a link: it underlines under the pointer and opens on click, in the
browser you picked, so a link from Claude no longer needs selecting, copying and a window switch.

- **Which browser** — Settings → **BROWSERS FOR LINKS**. Each entry is a name, the program, and
  the arguments it launches with; `--incognito` is the case this was built for, but the arguments
  are free-form so anything the browser takes works. The program and its arguments are stored
  and passed **separately**, straight to the process with no shell in between, so
  `C:\Program Files\Google\Chrome\Application\chrome.exe` needs no quoting and is never
  re-split on its spaces. **Browse…** picks it from disk. With the list empty, links open in your
  OS default browser.
- **More than one** — mark one as **Default** for a plain click, and **right-click any link** for
  the rest: every configured browser, the system default, and Copy link. That's the way to open
  something in a normal window when your default is incognito, without a trip through Settings.
- **Before you click** — hovering shows the full URL and which browser will open it. Worth reading
  when the link came from output you don't control.
- **Selecting still works** — a click only opens a link if it *was* a click: no drag between press
  and release, nothing selected. Drag-select a URL to copy it and nothing opens; double-click to
  select it and nothing opens either (opening waits out the double-click window first).
  **Ctrl/Cmd+click** opens as well, out of habit; **Shift+click** never does.
- **Only web links** — `http` and `https`, and nothing else. The URL is re-validated in the main
  process before anything launches, and reaches the browser as a single argument, so terminal
  output can't open a `file:`, reach a custom scheme handler, or smuggle in flags of its own.
  Programs that emit real OSC 8 hyperlinks go through the same check.

**File paths** in output (`src/app.ts`, `src/app.ts:42`) are links too, and open in an editor
rather than a browser — with `:42` putting the cursor on that line. Only paths that actually
exist inside the session's own folder become links, so ordinary text like `and/or` stays text.
Turn it off in Settings → **FILE PATHS IN OUTPUT**, or turn the whole thing off with **LINKS IN
TERMINAL OUTPUT**.

- **Which editor** — Settings → **EXTERNAL EDITOR**. Set the program and its arguments and a
  clicked path opens there, in whatever editor you already use. Program and arguments are stored
  and passed **separately**, straight to the process with no shell in between, so
  `C:\Program Files\Microsoft VS Code\Code.exe` needs no quoting. **Browse…** picks it from disk.
- **Jumping to the line** — every editor spells it differently, so the arguments take
  placeholders: `{path}`, `{line}` and `{column}` are filled in where you put them. VS Code is
  `-g {path}:{line}`, Sublime and Zed `{path}:{line}`, Notepad++ `-n{line}`, gvim `+{line}`. An
  argument mentioning `{line}` is dropped when the path had no line number (so `-n{line}` doesn't
  become a bare `-n`), and if no argument mentions `{path}` the file is added at the end — which
  is what a plain `editor <file>` wants, so leaving the arguments empty works too.
- **Or in the app** — leave the program blank and a click opens an **Editor pane** for that
  project instead, which is what it did before there was a setting. That needs a pane covering
  the project; if there isn't one it says so, and points here. **Right-click any path** for the
  other one either way, plus Copy path.
- **Still only inside the session's folder** — the path is re-resolved in the main process before
  anything launches, against that session's own directory, and reaches the editor as a single
  argument. So output can't talk the app into opening something the session couldn't already
  reach.

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
- **Click a link** — opens it in your configured browser; **right-click a link** for the other
  browsers and Copy link. See **Links** above for what stops a selection from opening one.
- **Click a file path** — opens it in your configured external editor (or an Editor pane when
  none is set); **right-click** for the other one, and Copy path.
- **Drop a file** on a pane to hand it to that session.
- **Esc** in a conversation view returns to that pane's live terminal. (Elsewhere a bare Esc
  still reaches the program in the pane, untouched.)

In the sidebar: **right-click** a session row, a collapsed-rail tab or a project header for its
menu (see **Session menus** above); arrows and Enter move and pick, **Esc** closes one level.

Elsewhere in the app: **Ctrl/Cmd+N** new session, **Ctrl/Cmd+B** toggle sidebar, **Alt+1..9**
jump to a session, **Esc** closes the top modal. The global show/hide hotkey (default `F12`)
and the notes hotkey (default `Ctrl/Cmd+Shift+N`) are configurable in Settings.

## Relaunching at startup

Sessions are remembered across restarts, but they come back **not running** — nothing is
launched behind your back, and each one waits behind its own **Relaunch** button. Switch
Settings → **STARTUP** to *Ask what to relaunch* and the app offers them back instead, once,
when it starts:

- One dialog lists everything that could be brought back, **every box ticked**, with each
  session's name and project (two sessions called `api` in two projects is the normal case).
  Untick what you'd rather leave alone and confirm; **Not now** — or **Esc** — relaunches
  nothing.
- Ticked sessions start exactly the way Start in the sidebar does: **off screen**, so the
  layout and the focused pane are left alone, and a Claude session comes back **resuming its
  conversation**, the same as the pane's own Relaunch. Open its pane whenever you like — the
  output it printed while off screen is waiting there.
- Unticked sessions are untouched: still not running, still one click from **Relaunch** in the
  pane or **Start** in the sidebar.
- Launches are spaced out rather than fired at once, so confirming with a dozen Claude sessions
  ticked doesn't fork a dozen processes in the same instant.
- Editor sessions are never listed — they have no process, and restore immediately usable.

The dialog is skipped entirely when the setting is off, or when nothing is left over to offer.
Every box starts ticked every time: last run's choices say nothing about what you want back
today.

## Settings

Settings live in a JSON file in the app's user-data directory (editable in-app via the gear
icon, or on disk). The panel is a set of foldable sections — collapsed, each one shows what it's
set to — and which ones you left open is remembered:

- `modes.normal.command` / `modes.readonly.command` — the Claude commands (defaults `claude`,
  `claude-readonly`). The app appends `--session-id` / `--resume` / `--settings`, so a custom
  read-only command must forward appended args (e.g. `exec claude --permission-mode plan "$@"`).
- `defaultShell`, `gitGuiCommand`, `worktreesRoot`, `projects`.
- `theme` — the active colour theme (see below), and `customTheme` for per-token overrides.
  Themes of your own live in their own file, `themes.json`, alongside this one.
- `relaunchOnStartup` — offer to relaunch last time's sessions when the app starts (default
  `false`). See **Relaunching at startup** above.
- `usageRefreshSeconds` — how often the footer's usage meter re-reads the clock
  (default 30, range 5–300). A display tick only; it never asks Claude for anything.
- `settingsOpen` — which Settings sections are expanded. Absent means collapsed.
- `notifications` — see below.
- `attachments.allowClaudeRead` / `attachments.keepDays` — see **Images and files** above.
- `links.browsers` (each `{ id, name, command, args }`), `links.defaultBrowserId`,
  `links.enabled`, `links.openFilePaths`, `links.editor` (`{ command, args }`) — see **Links**
  above.

## Themes

Settings → **THEME** is a grid of swatches, each painted in its own colours. Picking one applies
it immediately — to the app chrome, the terminal panes (background, cursor, selection **and the
16 ANSI colours**, so Claude's TUI takes on the theme) and the built-in file editor including
its syntax colours. Nothing needs a restart, and terminals that are open — even the ones parked
off-screen — repaint in place. The choice is saved as you make it; it doesn't wait for **Save
settings**, and **Cancel** doesn't take it back.

- **Yours** — anything you've made. See *Making your own* below.
- **Dark** — Terminator (the default), Darcula, One Dark, Dracula, Gruvbox Dark, Nord,
  Solarized Dark.
- **Light** — Solarized Light, GitHub Light.
- **Reading** — the Apple Books set: Original, Quiet, Paper, Bold, Calm, Focus. *Paper* is the
  warm cream-and-ink page, with the faint grain behind the chrome (panes stay flat, so nothing
  interferes with glyph rendering); *Bold* also raises the chrome's font weight.

The built-ins live in [`src/shared/themes.ts`](src/shared/themes.ts). Each is a compact seed — a
background, two text anchors, a few accents, and the terminal/editor palettes — from which the
six surface shades and the eleven-step text ramp are derived, so adding one is about 25 lines.
The built palette is published as CSS custom properties (`--c-bg`, `--c-ink-rgb`, …) that the
whole renderer reads, and handed to xterm and CodeMirror as literal colours, which is what those
two need.

### Making your own

The built-ins are read-only. To change one, **Duplicate** it. The copy captures exactly what you
were looking at — any `customTheme` overrides included — and is then yours: it will not move
again if the built-in it came from ever changes. Rename, duplicate and delete your own freely;
deleting the one you're using falls back to Terminator.

Your themes are stored in `themes.json`, next to `settings.json` but deliberately not in it — a
theme is seventy-odd colours and `settings.json` is a file you edit by hand.

**Edit** opens a view of its own rather than another block in the Settings scroll:

- **The basics** — the background, the two text anchors, the accents, the danger colour, and
  whether the theme is light or dark.
- **Depth** — one control that moves the sidebar, footer and panels away from the background as
  a group. Any individual surface can be pinned to hold still, and unpinned again.
- **Terminal** — the full ANSI set plus cursor and selection, over a sample of terminal output.
  This is where a published palette goes.
- **Editor syntax** — the ten token colours, shown against a real code sample.
- **The finer things**, folded away — the five session status colours, shadows, the icon tint,
  the interface font weight, and the nine derived ramp steps, each pinnable and un-pinnable.

Everything is live as you type — the chrome, every terminal pane including the ones parked
off-screen, and any open editor tab — because the editor drives the same repaint the picker
does rather than a preview of its own. There is no Save button: edits land a moment after you
stop. Combinations that make text unreadable raise a warning rather than being corrected or
refused, and a value that isn't a hex colour never leaves the box you typed it in.

**Export** hands you the theme as JSON to keep or send on. **Import** (Settings → THEME) takes
one back, and is deliberately forgiving: paste a published palette's `ansi` block on its own and
everything else fills in from the default. An import always arrives as a new theme rather than
overwriting one.

### Overriding a single colour by hand

To adjust a colour of a **built-in** without making a theme, add a `customTheme` block to
`settings.json`:

```json
{ "theme": "nord", "customTheme": { "accent": "#00b0ff", "bg": "#101216" } }
```

It overrides tokens of the selected theme by name (any surface, ramp step, `accent`,
`accentSoft`, `accentText`, `danger`, `kindIcon` or `shadow`). Values must be hex; anything else
is ignored rather than applied, so a typo can't blank the UI.

The block applies to built-ins only. One of your own themes already carries whatever was in
force when you duplicated it, so laying the same overrides on again would count them twice — and
would quietly swallow every edit you made in the theme editor to an overridden colour.

## Notifications

The built-in notification surface is **in-app only**: a type-coloured toast (with an "Open"
jump button) plus a highlight on the session's sidebar row.

For anything else — desktop notifications, sound, a phone push — configure a **notification
command** that the app runs on each notification, through your shell. It receives the event as
**JSON on stdin** and as `TERMINATOR_*` environment variables, and can branch on the type:

- `TERMINATOR_NOTIF_TYPE` ∈ `waiting | finished | error | exited | idle`
- `TERMINATOR_SESSION_NAME`, `TERMINATOR_PROJECT`, `TERMINATOR_BRANCH`, `TERMINATOR_STATUS`,
  `TERMINATOR_KIND`, `TERMINATOR_MODE`, `TERMINATOR_CWD`, `TERMINATOR_MESSAGE`

Configure which types fire it via `notifications.triggerOn` (default `["waiting","error"]`) and
optional per-type overrides via `notifications.perType`. A runnable example is in
[`examples/notify.py`](examples/notify.py).

## Tech

Electron + React + Vite (electron-vite), `@xterm/xterm` for the terminals, `@lydell/node-pty`
for the PTYs. The main process owns session state, PTYs, the hook/statusLine server, settings,
and persistence; the renderer mirrors session metadata and owns the keep-alive xterm instances.
That split is why the startup relaunch prompt lives in the renderer: a session's terminal has to
exist before its PTY starts or its first output has nowhere to land, and only the renderer can
make one.
The visual design lives in [`design/reference.html`](design/reference.html) — a static mockup of
the default theme, not wired into the build.
