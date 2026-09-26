# WSL sessions

How a session runs inside a WSL distro while Terminator stays a Windows app, what had to
change for that, and why each piece is shaped the way it is. The user-facing description is in
the README (**WSL sessions**); this is the map for changing it.

## The model

A session has an optional `runtime: { kind: 'wsl', distro }` (`src/shared/types.ts`). Absent
means Windows, so every `sessions.json` and `settings.json` written before this still loads as it
was. Remembered projects carry the same field.

A WSL session's `projectPath` / `worktreePath` are **Linux paths** (`/home/me/api`) — the strings
its own process, Claude's transcript folder, git and the user all use. This app reaches the same
folder through the distro's share, and there is exactly one mapping for that, shared by main and
renderer (`src/shared/wsl-path.ts`):

| helper | gives |
| --- | --- |
| `sessionFolder(s)` | the folder as the session's process sees it (Linux for WSL) |
| `hostFolder(s)` | the same folder as this process reaches it (`\\wsl.localhost\<distro>\…`) |
| `parseWslUnc` / `linuxToHost` / `hostToLinux` | the conversions, incl. `C:\x` → `/mnt/c/x` |
| `groupKey(s)` | sidebar grouping: the project name for Windows (unchanged), `wsl:<distro>\|name` for WSL |
| `findProject(list, path, runtime)` | a remembered project is a path *in* a runtime |

Everything that reads files for a WSL session — the Editor pane, links, transcripts, the hooks
merge — goes through `hostFolder`/`linuxToHost`. Everything that hands a path *to* the session —
`--settings`, attachments, the Ctrl+G shim — goes through `hostToLinux`/`winToLinux`.

## Talking to the distro (`src/main/wsl.ts`)

The only module that runs `wsl.exe`. Every call uses the absolute System32 `wsl.exe` with
`windowsHide` and `WSL_UTF8=1`, and keeps its argv to plain paths and names: node builds a Windows
command line that wsl.exe parses back, so anything with quoting goes on stdin to `sh -s` instead.

- `listDistros()` — `wsl -l -v`, parsed by shape (the header is localised). Never boots a distro.
- `probe(distro)` — one call that learns the user, home, login shell, automount root, networking
  mode, whether interop is on, whether this app's exe is reachable, `git --version`, and — from a
  login-interactive shell, last and with stdin closed so an rc file can't eat the script — where
  `claude` is and the **real** path of `${CLAUDE_CONFIG_DIR:-~/.claude}` (Windows can't follow a
  Linux symlink over the share). Cached per run; failures aren't.
- `normalizeCreateInput()` — settles a create request: a share path picks its distro, `~` and
  drive paths become Linux paths, and the folder is resolved inside the distro (`cd && pwd -P`),
  because Claude files transcripts under the real cwd.
- `reap()` — see **Stopping** below. `ensurePromptShim()` — see **Ctrl+G**.

## Launching (`src/main/session-launcher.ts`)

`startSession` returns a promise but isn't `async`: a Windows session still reaches its pty
synchronously, exactly as before. A WSL session goes through `startWsl`, which probes first
(and says why in the status line if the distro can't be reached).

- **Terminal**: `wsl.exe -d <distro> --cd <linux cwd>` — your normal login shell in that folder.
- **Claude**: the same plus `--exec <shell> -l -i -c 'eval "$TERMINATOR_LAUNCH"'`, with the
  whole command in the `TERMINATOR_LAUNCH` environment variable (listed in `WSLENV` as `/u`):
  - An environment variable arrives byte for byte; a command full of quotes needn't survive the
    Windows-command-line round trip through wsl.exe.
  - The command first exports the report port/token, the session id and `$VISUAL`, *after* the
    rc files have run — so a `.bashrc` that sets its own `VISUAL` can't win — then runs
    `claude … --session-id|--resume <id> --settings '/mnt/c/…/<id>.settings.json'`.
  - `eval`, not `exec`, so an alias like `claude-readonly` in `.bashrc` resolves. The shell is
    the login shell when it speaks POSIX quoting, else bash.
  - The session id then appears in one command line in the distro: Claude's.
- An in-flight guard: a second Start while the first is still probing is dropped, and Stop
  cancels a start that hasn't reached its pty.

## Status reporting — through interop

The report server stays bound to Windows' `127.0.0.1`. A WSL2 distro in the default NAT
networking can't reach that (measured: a connection to the host's gateway address times out at
the firewall), so a WSL session's hook and statusLine commands run the reporter on the *Windows*
side, through interop:

```
ELECTRON_RUN_AS_NODE=1 WSLENV=ELECTRON_RUN_AS_NODE /mnt/c/…/Terminator.exe 'C:\…\reporter.cjs' hook <port> <token> "$(date +%s%3N)"
```

- `ELECTRON_RUN_AS_NODE` is inline and handed over by `WSLENV`, never trusted to be in the
  environment — without it the exe is the whole app, and every hook would open a window (there
  is no single-instance lock).
- The exe is named by its Linux path, the script by its Windows one: interop passes arguments
  through untranslated, to a Windows program.
- The timestamp is taken by Linux as the hook fires and passed as argv[5]; the ~100 ms interop
  start would otherwise blur the order of hooks fired close together, which `report-server.ts`
  depends on. Stamps are only ever compared within one session, so the distro's clock is fine.

No firewall rule, no `.wslconfig` change, and the same path works in mirrored networking. Cost:
~100 ms per report warm (the first after boot ~2.6 s), about what a Windows session pays for its
Electron-as-Node reporter. A faster route exists if it's ever needed — `/mnt/c/Windows/System32/curl.exe`
is ~35 ms, and in mirrored mode Linux `curl` can post directly — at the price of a second reporter.

The per-session settings file merges the **distro's** `~/.claude/settings.json` and the
project's `.claude/` files (read through the share), never the Windows ones — their hooks would
be PowerShell. The attachments folder is pre-approved by its `/mnt/c/…` path.

## Transcripts

`transcriptDirFor(runtime, cwd)` (`src/main/transcript.ts`): for WSL,
`linuxToHost(<claudeDir>/projects/<cwd with non-alphanumerics as ->)`. Everything that reads it —
`--resume` vs `--session-id`, the conversation view (polled every 700 ms), the branch picker,
forking — is asynchronous, because the first read of the share after the VM idled out boots it,
and a synchronous read there would freeze the window for seconds. A fork is written next to its
parent, in the distro, owned by the distro user.

## Files

- **Editor pane**: rooted at `hostFolder(s)` on both sides. `fs.watch` throws on the share, so
  directories there are **polled** (1 s: a listing signature for expanded dirs, size+mtime for
  open files) through the same `onDirEvent` path, so debounce and self-write suppression apply
  unchanged. Saves on the share are written **in place** — replacing by rename would create a new
  Linux file with default mode, and `run.sh` would lose `+x` on every save.
- **Links**: a WSL session's printed paths are resolved by Linux rules against its Linux folder
  (`~` = the distro home), contained there, then mapped to the share.
- **Attachments**: `AttachedItem.path` stays the Windows receipt `openAttachment` checks;
  `sessionPath` is what gets typed or sent. Unreachable files (another distro, a network share)
  fail the whole drop.

## Git

WSL worktrees are made by the distro's git (`wslCheck(… git worktree add …)`) under
`settings.wsl.worktreesRoot`, with `--relative-paths` on git ≥ 2.48 so the link also works when
opened from Windows through the share. Windows git would write Windows paths that the Linux git
Claude runs can't follow.

## Stopping

Killing a WSL pty kills `wsl.exe`; Linux hears of it only as a hang-up on the terminal. In
practice that ends Claude, but a relaunch must never put two Claudes on one transcript, so after
a WSL Claude's pty exits `reap()` runs `pkill -TERM -f '[x]<rest of the session id>'` in the
distro, polls up to 2 s, then `-KILL` — the bracket makes the pattern match the id but not its
own command line. Every WSL start waits for a pending reap of its id, and quitting reaps whatever
was live (detached, so it survives the app). The reap script travels in argv, never on stdin: at
quit the app is gone before a pipe could be flushed, and a `sh -s` waiting on a stdin nobody
closes never exits.

## Ctrl+G

`$VISUAL` has to name something Linux can run, with no spaces (Claude splits it on them). So the
first WSL Claude start of each run writes `~/.cache/terminator/prompt-editor` into the distro — a
`#!/bin/sh` shim that runs the app's `prompt-editor.cjs` on the Windows side through interop,
passing `ELECTRON_RUN_AS_NODE` and the port/token/session id across with `WSLENV`. It is
rewritten every run because the portable build's exe moves each launch. The file it hands over
is Claude's Linux temp path (`/tmp/claude-1000/…`); `beginEdit` maps it through the session's
distro before granting it.

**Ctrl+C** is the awkward part, found by testing it for real. Claude leaves the terminal in cooked
mode for its editor, so Ctrl+C is a SIGINT to the whole foreground group — Claude included —
while the helper, a GUI-subsystem Windows program, gets no terminal input from interop at all
(its stdin simply ends). So the shim does the listening: it turns signals off and the terminal
raw (`-isig -icanon min 0 time 2`), runs the helper in the background, and reads keys with `dd`
(not bash's `read -n1`, which turns signals back on). A `0x03` runs the helper again with
`--cancel`, which posts `/edit-cancel` to the app; the app ends the edit, the first helper
exits, the terminal is restored, and Claude carries on with the prompt as it was — the same as
Ctrl+C on Windows.

Interop belongs to the `wsl.exe` instance a process was started under, and a Windows process it
starts isn't tied to the session's console: the helper can outlive the session. So when any
session's pty exits, `finishEditsForSession` ends its edits — which also answers the helper, so
it exits instead of lingering.

## Test checklist (Windows + a WSL2 distro)

- [ ] New Session shows **Run in** only when a distro is installed; Browse opens in the distro
      home; pasting `\\wsl.localhost\<distro>\…` selects the distro and shows the Linux path.
- [ ] A WSL Terminal is a login shell in the Linux folder, truecolor, resizes.
- [ ] A WSL Claude session: status dots (working / waiting / idle), statusLine metrics, usage
      meter, notification command (`TERMINATOR_RUNTIME=wsl`).
- [ ] Conversation view, find, composer send, branch (with and without worktree).
- [ ] Mode switch / Relaunch resume the same conversation; `pgrep -af <session id>` in the
      distro never shows two; Stop leaves none.
- [ ] Editor pane: tree, open, save keeps `+x`; an edit made by Claude appears within ~1 s.
- [ ] Links: `src/x.ts:12`, `/abs/linux/path`, `~/…` inside the folder open; outside don't.
- [ ] Paste a screenshot → `/mnt/c/…/paste-*.png`, readable without a prompt; drop from `C:\`
      and from the share; a drop from another distro is refused.
- [ ] Ctrl+G with **This app**: tab opens, Send it back returns the text, Ctrl+C releases.
- [ ] Build/Run on a WSL project runs in a WSL shell.
- [ ] Restart: sessions come back with their WSL tag; the relaunch prompt starts them.
- [ ] `wsl --shutdown` while sessions run: they go to exited; Start boots the distro again.
- [ ] Windows sessions unchanged: PowerShell terminal, Claude status, links, editor save, Ctrl+G.
