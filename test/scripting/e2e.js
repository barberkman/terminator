// End-to-end test of the `terminator` command (README → Scripting), against the real
// app: it starts Terminator with a throwaway profile, drives it with the command the
// app installs, and reads the window to see what a person would see — which pane is
// focused, where the keyboard is, what the sidebar shows. Claude is the stand-in in
// fake-claude.js, so the test needs no account and no network.
//
//   npm run build && npm run test:scripting          (Linux: under xvfb-run -a)
//
//   TERMINATOR_APP=<exe>   test a packaged build instead of out/ (with --quick, say)
//   --quick                skip the slow cases (the 20-second give-up, dialogs)
//   --portable <exe>       only the portable-build checks, against that exe
//   TERMINATOR_TEST_OUT    where the work folder and log go (default: the temp folder)
//   TERMINATOR_TEST_WSL    a WSL distro to run the command from (Windows, CI)
//
// On Windows it also checks what only Windows has: the compiled launcher, PowerShell 7
// and 5.1 quoting and exit codes, the .cmd fallback, Git Bash, a WSL shell, and — on
// CI only, since it edits your user PATH — Add to PATH.

const { _electron } = require('playwright-core')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const WIN = process.platform === 'win32'
const CI = !!process.env.CI
const args = process.argv.slice(2)
const QUICK = args.includes('--quick')
const PORTABLE = args.includes('--portable') ? path.resolve(args[args.indexOf('--portable') + 1]) : null
const APP = process.env.TERMINATOR_APP ? path.resolve(process.env.TERMINATOR_APP) : null
const REPO = path.resolve(__dirname, '..', '..')

const label = PORTABLE ? 'portable' : APP ? 'packaged' : 'dev'
const out = path.resolve(process.env.TERMINATOR_TEST_OUT || path.join(os.tmpdir(), 'terminator-scripting'))
const work = path.join(out, `work-${label}`)
fs.rmSync(work, { recursive: true, force: true })
const home = path.join(work, 'home')
const userData = path.join(work, 'userdata')
const proj = path.join(work, 'proj')
for (const d of [home, userData, proj]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(proj, 'big.txt'), 'x'.repeat(5000))
fs.writeFileSync(path.join(proj, 'small.txt'), 'y')
const bin = path.join(userData, 'bin')
const fake = path.join(__dirname, 'fake-claude.js')

fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    scripting: true,
    defaultShell: WIN ? 'pwsh.exe' : '/bin/bash',
    shellArgs: WIN ? ['-NoLogo', '-NoProfile'] : ['--norc', '--noprofile', '-i'],
    modes: {
      normal: { command: 'node', extraArgs: [fake] },
      readonly: { command: 'node', extraArgs: [fake] },
    },
  }),
)

/** `env` with `dir` in front of PATH, under whichever spelling of the key it already has. */
function withPath(env, dir) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ''}` }
}

// The profile is the test's own: transcripts and the stand-in's log under `home`.
const env = { ...process.env, HOME: home, USERPROFILE: home }
delete env.ELECTRON_RUN_AS_NODE
const logFile = path.join(work, 'e2e.log')
const fakeLog = path.join(home, 'fake-claude.log')

let failures = 0
function log(line) {
  console.log(line)
  fs.appendFileSync(logFile, line + '\n')
}
function check(name, ok, detail) {
  if (!ok) failures++
  const d = detail === undefined ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d}`)
}
const note = (s) => log(`NOTE  ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The command as a script runs it: the launcher on Windows, the sh shim elsewhere. */
function command() {
  if (!WIN) return path.join(bin, 'terminator')
  return fs.existsSync(path.join(bin, 'terminator.exe')) ? path.join(bin, 'terminator.exe') : null
}
function t(...a) {
  const exe = command()
  if (!exe) return { code: -1, out: '', err: 'no terminator command installed' }
  const r = spawnSync(exe, a, { env, encoding: 'utf8', cwd: proj, timeout: 180_000 })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
/** A script in a shell (pwsh, powershell, bash), with the command's folder on PATH. */
function shell(exe, a, extraEnv = {}, timeout = 600_000) {
  const r = spawnSync(exe, a, { env: withPath({ ...env, ...extraEnv }, bin), encoding: 'utf8', cwd: proj, timeout })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
const pwsh = (script, exe = 'pwsh') => shell(exe, ['-NoProfile', '-NonInteractive', '-Command', script])
const psq = (s) => `'${s.replace(/'/g, "''")}'`

async function waitFor(fn, ms, step = 200) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) {
    const v = await fn()
    if (v) return v
  }
  return fn()
}

function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'))
  } catch {
    return []
  }
}

/** The stand-in's reply to a prompt — what `reply` must print, byte for byte. */
const fakeReply = (prompt) => `Reply to: ${prompt}\n\n- one — two\n- three`

async function launch() {
  const executablePath = APP ?? require('electron')
  const appArgs = [...(APP ? [] : [REPO]), `--user-data-dir=${userData}`, ...(WIN ? [] : ['--no-sandbox'])]
  const app = await _electron.launch({ executablePath, args: appArgs, env, cwd: REPO })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function main() {
  log(`terminator scripting e2e — ${label} on ${process.platform}, work folder ${work}`)
  if (PORTABLE) return portable()

  const { app, page } = await launch()
  check('control.json written', await waitFor(() => fs.existsSync(path.join(userData, 'control.json')), 20_000))
  if (!WIN) check('control.json is private', (fs.statSync(path.join(userData, 'control.json')).mode & 0o777) === 0o600)
  if (WIN) {
    // Compiled in the background on first start, with the C# compiler Windows ships.
    check('terminator.exe was built', await waitFor(() => fs.existsSync(path.join(bin, 'terminator.exe')), 120_000, 1000))
    check('terminator.cmd is there to fall back on', fs.existsSync(path.join(bin, 'terminator.cmd')))
  }
  check('the sh shim is there', fs.existsSync(path.join(bin, 'terminator')))
  const target = fs.readFileSync(path.join(bin, 'terminator.target'), 'utf8').split(/\r?\n/)
  check('terminator.target names this app and its CLI', fs.existsSync(target[0]) && fs.existsSync(target[1]), target)

  const probe = () =>
    page.evaluate(() => {
      const a = document.activeElement
      const pane = a && a.closest('[data-pane-session]')
      return {
        active: pane ? pane.getAttribute('data-pane-session') : a ? a.tagName : null,
        mark: a ? a.getAttribute('data-e2e') : null,
        focused: [...document.querySelectorAll('[data-pane-focused="1"]')].map((e) => e.getAttribute('data-pane-session')),
        panes: [...document.querySelectorAll('[data-pane-index]')]
          .sort((x, y) => Number(x.getAttribute('data-pane-index')) - Number(y.getAttribute('data-pane-index')))
          .map((e) => e.getAttribute('data-pane-session')),
      }
    })
  const screen = (name) =>
    page.evaluate((n) => document.querySelector(`[data-pane-session="${n}"] .xterm-rows`)?.textContent ?? '', name)

  let r = t('list')
  check('list on an empty app', r.code === 0 && r.out.startsWith('ID'), r)

  // ---- shells, panes and focus ------------------------------------------------
  r = t('new', 'shell', '--project', '.', '--name', 'base')
  const base = r.out
  check('new shell into the empty pane', r.code === 0 && /^[0-9a-f-]{36}$/.test(base), r)
  await sleep(1500)
  let p = await probe()
  check('it fills the empty pane', p.panes.length === 1 && p.panes[0] === 'base', p)
  check('a script-filled pane does not take the keyboard', p.active !== 'base', p)

  // You click into it and type.
  await page.click('[data-pane-session="base"] .xterm')
  await page.evaluate(() => document.activeElement && document.activeElement.setAttribute('data-e2e', 'mine'))
  await page.keyboard.type('echo one')
  p = await probe()
  check('clicking makes it yours', p.active === 'base' && p.mark === 'mine', p)

  const placed = []
  for (const [name, side, want] of [
    ['right1', 'right', 'base,right1'],
    ['left1', 'left', 'left1,base,right1'],
    ['up1', 'up', 'left1,up1,base,right1'],
  ]) {
    r = t('new', 'shell', '--project', proj, '--name', name, '--split', side)
    placed.push(r.out)
    await sleep(1000)
    p = await probe()
    check(`--split ${side} opens beside your pane`, r.code === 0 && p.panes.join() === want, p)
    check(`... and your pane keeps the focus and the keyboard`, p.focused.join() === 'base' && p.active === 'base' && p.mark === 'mine', p)
  }
  const [right1, left1, up1] = placed

  await page.keyboard.type(' two')
  await page.keyboard.press('Enter')
  await sleep(1000)
  check('keystrokes stayed in your terminal', /one two/.test(await screen('base')), (await screen('base')).slice(-160))

  // A shell opened in the app finds the command on its PATH. Its answer is short, so
  // it can't scroll out of a narrow pane.
  await page.keyboard.type('terminator stop no/such')
  await page.keyboard.press('Enter')
  const inShell = await waitFor(async () => {
    const s = (await screen('base')).replace(/\s+/g, '')
    return s.includes("terminator:there'snosessioncalledno/such") ? s : null
  }, 15_000)
  check('a shell inside the app runs `terminator`', !!inShell, (await screen('base')).slice(-200))

  // ---- names, list, json ------------------------------------------------------
  r = t('list', '--json')
  const listed = JSON.parse(r.out || '{}')
  check('list --json', r.code === 0 && listed.ok && listed.sessions.length === 4, listed.sessions?.map((s) => s.name))
  check(
    'list fields',
    !!listed.sessions?.every((s) => s.id && s.kind === 'shell' && s.project === 'proj' && s.branch === 'main' && s.status),
    listed.sessions?.[0],
  )
  r = t('wait', 'proj/right1', 'idle', 'working', '--timeout', '5s')
  check('project/name finds a session', r.code === 0 && /^(idle|working)$/.test(r.out), r)
  r = t('new', 'shell', '--project', proj, '--name', 'right1', '--split', 'down')
  const dupe = r.out
  await sleep(800)
  r = t('stop', 'proj/right1')
  check('an ambiguous name is refused', r.code === 1 && /matches 2 sessions/.test(r.err), r)
  r = t('stop', 'proj/nope')
  check('an unknown name is refused', r.code === 1 && /no session called/.test(r.err), r)

  // ---- send / wait / stop / remove on shells ---------------------------------
  r = t('send', right1, 'hello')
  check('send refuses a shell', r.code === 1 && /only a Claude session/.test(r.err), r)
  await t('wait', right1, 'idle', '--timeout', '10s')
  r = t('wait', right1, 'closed', '--timeout', '1s')
  check('wait times out with exit 2', r.code === 2 && /timed out/.test(r.err), r)
  r = t('--json', 'wait', right1, 'closed', '--timeout', '500ms')
  check('wait --json timeout', r.code === 2 && JSON.parse(r.out || '{}').timedOut === true, r)
  r = t('stop', right1)
  check('stop', r.code === 0, r)
  r = t('wait', right1, 'closed', '--timeout', '5s')
  check('a stopped session reads closed', r.code === 0 && r.out === 'closed', r)
  r = t('stop', right1)
  check('stopping a stopped session is refused', r.code === 1 && /isn't running/.test(r.err), r)
  r = t('list', '--json')
  check('a stopped session stays in the list', JSON.parse(r.out || '{}').sessions?.some((s) => s.id === right1))
  const before = (await probe()).panes.length
  r = t('remove', right1)
  check('remove', r.code === 0, r)
  await sleep(800)
  p = await probe()
  check('its pane closed, yours kept the keyboard', p.panes.length === before - 1 && p.focused.join() === 'base' && p.mark === 'mine', p)
  for (const id of [left1, up1, dupe]) t('remove', id)
  r = t('new', 'shell', '--project', path.join(work, 'missing'))
  check('a missing folder is refused', r.code === 1 && /no folder at/.test(r.err), r)
  r = t('new', 'shell', '--project', proj, '--branch', 'b')
  check('--branch needs --worktree', r.code === 1 && /needs --worktree/.test(r.err), r)

  // ---- Claude: the loop, from this process ------------------------------------
  const prompt = 'List the files in this folder and say which one is "largest" & why'
  for (let i = 1; i <= 2; i++) {
    const t0 = Date.now()
    r = t('new', 'claude', '--project', proj, '--name', `try-${i}`, '--split', 'right')
    const id = r.out
    check(`try-${i}: new claude`, r.code === 0 && /^[0-9a-f-]{36}$/.test(id), r)
    r = t('send', id, prompt)
    check(`try-${i}: send straight after new waits for ready`, r.code === 0 && Date.now() - t0 > 1400, { ...r, ms: Date.now() - t0 })
    r = t('wait', id, 'idle', 'error', '--timeout', '2m')
    check(`try-${i}: wait covers the prompt's turn`, r.code === 0 && r.out === 'idle' && Date.now() - t0 > 2800, { ...r, ms: Date.now() - t0 })
    r = t('reply', id)
    check(`try-${i}: reply is the turn's markdown, quotes and & intact`, r.code === 0 && r.out === fakeReply(prompt), r.out)
    p = await probe()
    check(`try-${i}: your pane kept the keyboard`, p.focused.join() === 'base' && p.mark === 'mine', p)
    check(`try-${i}: stop`, t('stop', id).code === 0)
    check(`try-${i}: remove`, t('remove', id).code === 0)
  }

  // ---- Claude: a dialog, and the edges of turn tracking -----------------------
  r = t('new', 'claude', '--project', proj, '--name', 'asker')
  const asker = r.out
  if (!QUICK) {
    check('asker: send', t('send', asker, 'please ASK first').code === 0)
    r = t('wait', asker, 'idle', 'waiting', '--timeout', '1m')
    check('wait reports waiting on a dialog', r.code === 0 && r.out === 'waiting', r)
    r = t('send', asker, 'more')
    check('send refuses while a dialog is up', r.code === 1 && /waiting on something in its terminal/.test(r.err), r)
    const dot = await page.evaluate(() => document.querySelectorAll('span[style*="cc-notif"]').length)
    check('the sidebar shows the "needs me" dot', dot > 0, dot)
    r = t('reply', asker)
    check('reply skips the turn still in progress', r.code === 1 && /no finished reply/.test(r.err), r)
    // You answer it in its terminal.
    await page.evaluate((id) => window.terminator.writePty(id, 'y\r'), asker)
    r = t('wait', asker, 'idle', '--timeout', '1m')
    check('answered by hand, the turn finishes', r.code === 0 && r.out === 'idle', r)

    // The submit hook is lost: the transcript is the receipt.
    let t0 = Date.now()
    t('send', asker, 'NOHOOK turn')
    r = t('wait', asker, 'idle', '--timeout', '1m')
    check('a lost submit hook: wait still waits for the turn', r.code === 0 && r.out === 'idle' && Date.now() - t0 > 1400, { ...r, ms: Date.now() - t0 })
    check('... and reply is that turn', t('reply', asker).out === fakeReply('NOHOOK turn'))

    // A slash command never becomes a turn: let go after 20s of quiet, with a warning.
    t0 = Date.now()
    t('send', asker, '/clear')
    r = t('wait', asker, 'idle', '--timeout', '90s')
    check(
      'a prompt that never becomes a turn is let go, with a warning',
      r.code === 0 && r.out === 'idle' && /never showed up/.test(r.err) && Date.now() - t0 >= 19_000,
      { ...r, ms: Date.now() - t0 },
    )
  }

  if (WIN) await windowsChecks(page, asker)
  t('remove', asker)
  check('no prompt was ever typed before Claude was ready', !/DROPPED/.test(fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8') : ''))

  // ---- access ------------------------------------------------------------------
  const ctl = JSON.parse(fs.readFileSync(path.join(userData, 'control.json'), 'utf8'))
  const raw = (headers) =>
    new Promise((done) => {
      const req = http.request({ host: '127.0.0.1', port: ctl.port, path: '/v1/list', method: 'POST', headers }, (res) => {
        res.resume()
        done(res.statusCode)
      })
      req.on('error', () => done('error'))
      req.end('{"protocol":1}')
    })
  check('a wrong token is refused', (await raw({ authorization: 'Bearer nope' })) === 401)
  check('a web page is refused', (await raw({ authorization: `Bearer ${ctl.token}`, origin: 'https://example.com' })) === 403)
  check('the right token works', (await raw({ authorization: `Bearer ${ctl.token}` })) === 200)

  // Off in Settings — the same IPC its Save button uses.
  await page.evaluate(() => window.terminator.updateSettings({ scripting: false }))
  r = t('list')
  check('off: the command says so', r.code === 1 && /scripting is off/.test(r.err), r)
  check('off: control.json is gone', !fs.existsSync(path.join(userData, 'control.json')))
  await page.evaluate(() => window.terminator.updateSettings({ scripting: true }))
  await waitFor(() => fs.existsSync(path.join(userData, 'control.json')), 5000)
  check('back on', t('list').code === 0)

  await app.close()
  r = t('list')
  check('not running: the command says so', r.code === 1 && /isn't running/.test(r.err), r)
}

/** What only Windows has. `asker` is a running stand-in Claude to send to. */
async function windowsChecks(page, asker) {
  const exe = path.join(bin, 'terminator.exe')
  const replyAfter = (id) => {
    t('wait', id, 'idle', 'error', '--timeout', '1m')
    return t('reply', id).out
  }

  // The README's loop, in PowerShell 7, finding the command on PATH.
  const ver = pwsh('$PSVersionTable.PSVersion.ToString()').out
  note(`pwsh ${ver}`)
  const results = path.join(work, 'loop')
  fs.mkdirSync(results, { recursive: true })
  let r = shell('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'loop.ps1'), '-Project', proj, '-Dir', results])
  check('PowerShell 7: the README loop runs clean', r.code === 0, r)
  const ids = [...r.out.matchAll(/^try-\d ([0-9a-f-]{36})$/gm)].map((m) => m[1])
  check('PowerShell 7: $id = terminator new … captured each id', ids.length === 2, r.out)
  const want = fakeReply('List the files in this folder and say which one is largest') + '\n'
  for (const n of [1, 2]) {
    const file = path.join(results, 'results', `try-${n}.md`)
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0)
    // PowerShell 7.4+ keeps a native command's bytes through `>`.
    const [major, minor] = ver.split('.').map(Number)
    const exact = major > 7 || (major === 7 && minor >= 4)
    const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString('utf16le').slice(1) : bytes.toString('utf8')
    check(
      `PowerShell 7: results\\try-${n}.md holds the reply${exact ? ', UTF-8 byte for byte' : ''}`,
      exact ? bytes.equals(Buffer.from(want, 'utf8')) : text.replace(/\r\n/g, '\n').trim() === want.trim(),
      text.slice(0, 120),
    )
  }

  // Quoting: what PowerShell hands the command arrives as typed.
  r = pwsh(`terminator send ${psq(asker)} 'say "hi" & bye'; exit $LASTEXITCODE`)
  check('PowerShell 7: quotes and & arrive intact', r.code === 0 && replyAfter(asker) === fakeReply('say "hi" & bye'), r)
  r = pwsh(`terminator send ${psq(asker)} 'R&D'; exit $LASTEXITCODE`, 'powershell')
  check('PowerShell 5.1: a bare & arrives intact', r.code === 0 && replyAfter(asker) === fakeReply('R&D'), r)
  r = pwsh(`terminator send ${psq(asker)} 'say \\"hi\\" now'; exit $LASTEXITCODE`, 'powershell')
  check('PowerShell 5.1: \\" escaping, as the README says', r.code === 0 && replyAfter(asker) === fakeReply('say "hi" now'), r)
  r = pwsh(`terminator wait ${psq(asker)} closed --timeout 1s; exit $LASTEXITCODE`)
  check('PowerShell: $LASTEXITCODE is 2 when wait times out', r.code === 2, r)
  r = pwsh('terminator stop nope/nope; exit $LASTEXITCODE')
  check('PowerShell: $LASTEXITCODE is 1 on failure', r.code === 1, r)

  // The .cmd fallback, for when the launcher couldn't be built.
  fs.renameSync(exe, exe + '.off')
  try {
    r = pwsh('terminator list; exit $LASTEXITCODE')
    check('.cmd fallback: runs', r.code === 0 && r.out.startsWith('ID'), r)
    r = pwsh(`terminator wait ${psq(asker)} closed --timeout 1s; exit $LASTEXITCODE`)
    check('.cmd fallback: exit codes come through', r.code === 2, r)
  } finally {
    fs.renameSync(exe + '.off', exe)
  }

  // Git Bash: the sh shim's MSYS branch.
  const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((b) => fs.existsSync(b))
  if (!gitBash) note('no Git Bash here')
  else {
    const before = fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').length : 0
    r = shell(gitBash, ['-c', 'export PATH="$(cygpath -u "$BIN"):$PATH"; terminator send "$ID" "/no-conversion check"'], {
      BIN: bin,
      ID: asker,
    })
    await sleep(1500)
    const tail = fs.readFileSync(fakeLog, 'utf8').slice(before)
    check('Git Bash: a /path-looking prompt arrives unrewritten', r.code === 0 && /slash: \/no-conversion check/.test(tail), { ...r, tail })
    r = shell(gitBash, ['-c', 'export PATH="$(cygpath -u "$BIN"):$PATH"; terminator new shell --project /c/Windows --name gitbash --split right'], { BIN: bin })
    await sleep(1000)
    const s = readSessions().find((x) => x.id === r.out)
    check('Git Bash: --project /c/Windows is C:\\Windows', r.code === 0 && /^C:\\Windows$/i.test(s?.projectPath ?? ''), { ...r, projectPath: s?.projectPath })
    t('remove', r.out)
    r = shell(gitBash, ['-c', 'export PATH="$(cygpath -u "$BIN"):$PATH"; terminator wait "$ID" closed --timeout 1s; echo "rc=$?"'], { BIN: bin, ID: asker })
    check('Git Bash: exit codes come through', /rc=2/.test(r.out), r)
  }

  // A WSL shell: its sh shim hands over to terminator.exe through interop.
  const distro = process.env.TERMINATOR_TEST_WSL
  if (!distro) note('TERMINATOR_TEST_WSL not set: no WSL check')
  else {
    /** A command line in the distro, with the command's folder on its PATH. */
    const wsl = (cmd, timeout = 90_000) =>
      shell('wsl.exe', ['-d', distro, '--', 'bash', '-lc', `export PATH="$PATH:$(wslpath -u '${bin}')" && cd /tmp && ${cmd}`], {}, timeout)
    r = wsl('terminator list --json')
    check('WSL: list through interop', r.code === 0 && r.out.includes(`"id":"${asker}"`), r)
    r = wsl(`terminator wait ${asker} closed --timeout 1s; echo "rc=$?"`)
    check('WSL: exit codes come through interop', /rc=2/.test(r.out), r)
    r = wsl('mkdir -p /tmp/wproj && terminator new shell --project wproj --name wsl1 --split right')
    const id = r.out.split(/\r?\n/).pop()
    await sleep(1000)
    const s = readSessions().find((x) => x.id === id)
    check(
      'WSL: a relative --project from a Linux shell makes a session in that distro',
      r.code === 0 && s?.runtime?.kind === 'wsl' && s?.projectPath === '/tmp/wproj',
      { ...r, session: s && { runtime: s.runtime, projectPath: s.projectPath } },
    )
    // Removed from Windows: on the runner's WSL 1, the distro can't be entered at all —
    // `wsl.exe -- echo` hangs too — while the app has a shell open in it.
    check('WSL: remove', t('remove', id).code === 0)
    await sleep(2000)
    r = wsl('terminator list --json')
    check('WSL: the command works again once that shell is gone', r.code === 0 && !r.out.includes(id) && r.out.includes(asker), r)
  }

  // Add to PATH — it edits the user PATH for real, so only on CI.
  if (!CI) note('not CI: Add to PATH left alone')
  else {
    const query = () => spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' }).stdout ?? ''
    const cur = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(query())?.[1]?.trim() ?? ''
    spawnSync('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', `${cur ? cur + ';' : ''}%USERPROFILE%\\keepme`, '/f'])
    const info = await page.evaluate(() => window.terminator.addCommandToPath())
    const after = query()
    check('Add to PATH: the folder is on the user PATH', info.onPath && after.toLowerCase().includes(bin.toLowerCase()), { info, after })
    check('Add to PATH: %USERPROFILE% entries stay unexpanded', after.includes('%USERPROFILE%\\keepme') && /REG_EXPAND_SZ/.test(after), after)
    const again = await page.evaluate(() => window.terminator.addCommandToPath())
    const count = query().toLowerCase().split(bin.toLowerCase()).length - 1
    check('Add to PATH: twice adds it once', again.onPath && count === 1, count)
  }
}

/** The portable build runs from a temp folder that is gone once it quits. */
async function portable() {
  const child = spawn(PORTABLE, [`--user-data-dir=${userData}`], { env, stdio: 'ignore' })
  const ctlFile = path.join(userData, 'control.json')
  check('portable: started, scripting listening', await waitFor(() => fs.existsSync(ctlFile), 180_000, 1000))
  check('portable: terminator.exe built', await waitFor(() => fs.existsSync(path.join(bin, 'terminator.exe')), 120_000, 1000))
  const target = fs.readFileSync(path.join(bin, 'terminator.target'), 'utf8').split(/\r?\n/)
  check(
    'portable: the command runs the unpacked app, not the portable exe',
    fs.existsSync(target[0]) && path.resolve(target[0]).toLowerCase() !== PORTABLE.toLowerCase(),
    target[0],
  )
  check('portable: list', t('list').code === 0)
  const r = t('new', 'shell', '--project', proj, '--name', 'p1')
  check('portable: new shell', r.code === 0 && /^[0-9a-f-]{36}$/.test(r.out), r)
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  for (const pid of [JSON.parse(fs.readFileSync(ctlFile, 'utf8')).pid]) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'])
  await sleep(3000)
  const after = t('list')
  check("portable: once it's gone, the command says it isn't running", after.code === 1 && /isn't running/.test(after.err), after)
}

main()
  .catch((e) => {
    failures++
    log(`FAIL  crashed: ${e && e.stack ? e.stack : e}`)
  })
  .finally(() => {
    log(failures ? `\n${failures} FAILED` : '\nall passed')
    process.exit(failures ? 1 : 0)
  })
