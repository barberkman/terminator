# Windows / PowerShell support

Cross-platform analysis of how Terminator launches shells and Claude sessions, what
already works on Windows, and the small changes made so **PowerShell is the default
shell on Windows** — without altering the Linux/macOS behavior.

## How shells are launched

All shell selection and argument formatting lives in one place: [`src/main/shell.ts`](../src/main/shell.ts).

- `defaultShell()` — the shell used for new sessions. Single source of truth, imported by
  both `settings.ts` (the stored default) and `pty-manager.ts` (the spawn-time fallback).
- `shellRunArgs(shell, command, interactive)` — turns a command **string** into the argv
  array for that shell.
- `quoteFor(shell, value)` / `shquote(value)` — quote values we interpolate into a command
  string (the Claude `--settings` path and any user `extraArgs`).

PTYs are created in [`src/main/pty-manager.ts`](../src/main/pty-manager.ts) via
[`@lydell/node-pty`](https://www.npmjs.com/package/@lydell/node-pty), which ships prebuilt
N-API binaries for Windows (ConPTY), macOS, and Linux — there is no native rebuild step.

Two launch shapes:

- **Plain Terminal session** — `pty.spawn(defaultShell, settings.shellArgs)` (default
  `shellArgs: []`), i.e. a bare interactive shell prompt.
- **Claude session** ([`src/main/session-launcher.ts`](../src/main/session-launcher.ts)) —
  a command string (`claude --session-id … --settings …`) is run *through* the shell with
  `shellRunArgs(defaultShell, command, /* interactive */ true)`, so the user's environment
  (aliases/functions/profile) is in scope.

## Windows vs. POSIX behavior

| Concern | POSIX (Linux/macOS) | Windows |
| --- | --- | --- |
| Default shell | `$SHELL` → `/bin/bash` | `pwsh.exe` if on PATH → `powershell.exe` |
| Run a command string | `-ic` (interactive) / `-lc` (login) | PowerShell: `-NoLogo -Command <cmd>`; cmd: `/d /s /c <cmd>` |
| Profile / aliases | `-i` sources `~/.bashrc`/`~/.zshrc` | `-Command` loads `$PROFILE` by default (no `-NoProfile`) |
| Value quoting | single quotes, `'\''` escaping | PowerShell: single quotes, `''` escaping; cmd: shquote |

PowerShell 7 (`pwsh`) and Windows PowerShell 5.1 (`powershell`) are both detected by
substring in `shellRunArgs`/`quoteFor`, so both get PowerShell-shaped argv and quoting.

## What already worked

- `shellRunArgs` already had a PowerShell branch (`-NoLogo -Command`) and a cmd branch.
- `node-pty` already supports Windows ConPTY out of the box.
- Settings and on-disk paths use `app.getPath()` + `node:os`/`node:path`, so they are
  OS-correct (`%APPDATA%\Terminator\settings.json` on Windows).
- Because the Claude command runs through `-Command` (which loads `$PROFILE` unless
  `-NoProfile` is passed), a PowerShell profile function — e.g. a `claude-readonly`
  function — resolves, mirroring the interactive-bash rationale used on POSIX.

## What changed

1. **PowerShell is now the Windows default.** Previously `defaultShell()` returned
   `process.env.COMSPEC` first, which is always **cmd.exe** — so a fresh Windows install
   launched cmd, not PowerShell. It now prefers `pwsh.exe` (if on PATH), then
   `powershell.exe` (always present on Windows ≥ 5.1). cmd users can still select it
   explicitly in Settings.
2. **`defaultShell()` deduplicated.** It existed verbatim in both `settings.ts` and
   `pty-manager.ts`; both now import the single copy in `shell.ts`.
3. **PowerShell-correct quoting.** `quoteFor(shell, value)` was added: on Windows +
   PowerShell it single-quotes with doubled-quote (`''`) escaping (PowerShell's literal-string
   rule), so a `--settings C:\Users\…\<id>.json` path is passed verbatim. POSIX output is
   byte-for-byte identical to the previous `shquote`.

The POSIX code paths (`-ic`/`-lc`, `/bin/bash`, `shquote`) are unchanged.

## Overriding the shell

`defaultShell` is just the starting default. It is user-editable in **Settings → defaultShell**
(persisted to `settings.json`), so a user can point it at `powershell.exe`, `pwsh`, `cmd.exe`,
WSL `bash`, etc. `shellArgs` adds extra args for plain Terminal sessions.

## Out of scope (verify separately on Windows)

- **Git GUI** (`worktree.ts` `openGitGui`) defaults to `gitext` and is `spawn`ed without a
  shell; on Windows a `.cmd`/`.bat` launcher may need its extension or `shell: true`.
- **`git` worktree calls** (`worktree.ts`) use `execFile('git', …)`; Node resolves `git.exe`
  on PATH, but this hasn't been exercised on Windows here.
- **`process.env.HOME` fallback** in `pty-manager.ts` `createPty` is unset on Windows
  (Windows uses `USERPROFILE`); it is only a last-resort fallback because `session-launcher.ts`
  always supplies an explicit `cwd`.

## Manual Windows test checklist

This repo's CI/dev environment is Linux, so the Windows path can't be exercised here. On a
Windows machine:

- [ ] Fresh launch with PowerShell 7 installed → new Terminal session is `pwsh`.
- [ ] Fresh launch without PS7 → new Terminal session is `powershell.exe` (5.1).
- [ ] Start a Claude session → `--session-id` / `--settings <path>` parse correctly and the
      session reports status (hooks fire).
- [ ] Define a function in `$PROFILE` (e.g. `claude-readonly`) and confirm it resolves.
- [ ] Set `defaultShell` to `cmd.exe` in Settings → sessions still launch via the cmd branch.
- [ ] Confirm Linux is unaffected: `npm run dev` still spawns `$SHELL`/bash with `-ic`.
