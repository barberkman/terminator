// End-to-end test of what's particular to macOS, against the real app: it starts
// Terminator the way the Dock does — launchd's bare PATH, no LANG, a terminal's
// variables left over — with a throwaway profile and a home of its own, and reads
// the window to see what a person would see.
//
//   npm run build && npm run test:mac
//
//   TERMINATOR_APP=<exe>   test a packaged build instead of out/
//                          (release/mac-arm64/Terminator.app/Contents/MacOS/Terminator)
//   --quick                skip the slow cases (a shell that takes 30 s to start up)
//   --only A,C             run only those sections
//   TERMINATOR_TEST_OUT    where the work folder and log go (default: the temp folder,
//                          which on macOS is behind a symlink — that's on purpose)
//
// Sections: A environment · B start failures · C keyboard · D menu and window ·
// E transcripts on symlinked and miscased paths · F launching .app bundles ·
// G a file copied in Finder · H panes, theme, title bar, restart.
//
// Keys are sent through the DevTools protocol, so they reach the page's handlers but
// never the macOS menu's shortcuts: the menu is checked by reading it instead.
// Option-key characters are sent with the character a Turkish-PC layout gives, since
// the protocol's keyboard is a US one.

const { _electron } = require('playwright-core')
const { spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

if (process.platform !== 'darwin') {
  console.log('test/mac/e2e.js is for macOS; nothing to do here')
  process.exit(0)
}

const args = process.argv.slice(2)
const QUICK = args.includes('--quick')
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1].toUpperCase().split(',') : null
const APP = process.env.TERMINATOR_APP ? path.resolve(process.env.TERMINATOR_APP) : null
const REPO = path.resolve(__dirname, '..', '..')
const run = (section) => !ONLY || ONLY.includes(section)

const label = APP ? 'packaged' : 'dev'
const out = path.resolve(process.env.TERMINATOR_TEST_OUT || path.join(os.tmpdir(), 'terminator-mac'))
const work = path.join(out, `work-${label}`)
fs.rmSync(work, { recursive: true, force: true })
const home = path.join(work, 'home')
const userData = path.join(work, 'userdata')
const proj = path.join(work, 'proj')
const realProj = path.join(work, 'Real-Proj')
const linkProj = path.join(work, 'link-proj')
const tmp = path.join(work, 'tmp')
for (const d of [home, userData, proj, realProj, tmp]) fs.mkdirSync(d, { recursive: true })
fs.symlinkSync(realProj, linkProj)
fs.writeFileSync(path.join(proj, 'small.txt'), 'one\ntwo\nthree\nfour\n')
fs.writeFileSync(path.join(proj, '.DS_Store'), 'Bud1')
fs.writeFileSync(path.join(realProj, 'small.txt'), 'y')
const bin = path.join(userData, 'bin')
const fake = path.join(REPO, 'test', 'scripting', 'fake-claude.js')
const logFile = path.join(work, 'e2e.log')
const fakeLog = path.join(home, 'fake-claude.log')

// The home a login shell builds its PATH from. `node` is only reachable through
// .zshrc, and the stand-in Claude is started as plain `node` — so a Claude session
// comes up only if its shell read .zshrc, the way nvm users' does.
const rcBin = path.join(home, 'rc-bin')
const zpBin = path.join(home, 'zp-bin')
fs.mkdirSync(rcBin)
fs.mkdirSync(zpBin)
fs.symlinkSync(process.execPath, path.join(rcBin, 'node'))
const editorLog = path.join(work, 'fake-editor.log')
fs.writeFileSync(path.join(rcBin, 'fake-editor'), `#!/bin/sh\necho "$@" >> '${editorLog}'\n`, { mode: 0o755 })
const zshrc = (extra = '') =>
  fs.writeFileSync(
    path.join(home, '.zshrc'),
    `${extra}\nexport FROM_ZSHRC=1\nexport PATH="$HOME/rc-bin:$PATH"\nalias fake-claude-ro=node\n`,
  )
fs.writeFileSync(path.join(home, '.zprofile'), 'export FROM_ZPROFILE=1\nexport PATH="$HOME/zp-bin:$PATH"\n')
zshrc()

// A key probe: run in a shell pane, it prints the bytes of every key it gets as hex.
const probeJs = path.join(work, 'probe.js')
fs.writeFileSync(
  probeJs,
  `process.stdin.setRawMode(true)
process.stdout.write('PROBE-READY\\r\\n')
process.stdin.on('data', (d) => { process.stdout.write('<' + d.toString('hex') + '>'); if (d.includes(4)) process.exit() })
`,
)

/** A stand-in .app bundle whose program writes its arguments to `logTo`. */
function stubApp(name, logTo) {
  const app = path.join(work, `${name}.app`)
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>stub-exe</string>
<key>CFBundleIdentifier</key><string>test.terminator.${name.replace(/\W/g, '')}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  )
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'stub-exe'), `#!/bin/sh\necho "launched $*" >> '${logTo}'\n`, {
    mode: 0o755,
  })
  return app
}
const browserLog = path.join(work, 'stub-browser.log')
const stubBrowser = stubApp('Stub Browser', browserLog)
const stubEditor = stubApp('Stub Editor', editorLog)

fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    scripting: true,
    defaultShell: '/bin/zsh',
    shellArgs: [],
    modes: {
      normal: { command: 'node', extraArgs: [fake] },
      readonly: { command: 'fake-claude-ro', extraArgs: [fake] },
    },
    links: {
      enabled: true,
      requireCtrlClick: true,
      browsers: [
        { id: 'stub', name: 'Stub', command: stubBrowser, args: ['--incognito'] },
        { id: 'stub-plain', name: 'Stub plain', command: stubBrowser, args: [] },
        { id: 'nope', name: 'Nope', command: '/Applications/Nope Nope.app', args: [] },
      ],
      defaultBrowserId: '',
      openFilePaths: true,
      editor: { command: stubEditor, args: ['-g', '{path}:{line}'] },
      defaultEditorId: '',
    },
  }),
)

// Launched the way the Dock launches it: launchd's PATH, no locale, and the
// variables of the terminal the test happens to run in, which must not leak.
const env = {
  HOME: home,
  USER: os.userInfo().username,
  LOGNAME: os.userInfo().username,
  SHELL: '/bin/zsh',
  TMPDIR: tmp + '/',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  __CF_USER_TEXT_ENCODING: process.env.__CF_USER_TEXT_ENCODING ?? '0x1F5:0x0:0x0',
  TERM_PROGRAM: 'Apple_Terminal',
  TERM_SESSION_ID: 'planted-session',
}

let failures = 0
function log(line) {
  console.log(line)
  fs.appendFileSync(logFile, line + '\n')
}
function check(name, ok, detail) {
  if (!ok) failures++
  const d = detail === undefined ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d}`)
  return ok
}
const note = (s) => log(`NOTE  ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms, step = 200) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) {
    const v = await fn()
    if (v) return v
  }
  return fn()
}

function t(...a) {
  const r = spawnSync(path.join(bin, 'terminator'), a, { env, encoding: 'utf8', cwd: proj, timeout: 120_000 })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
const fakeLines = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').split('\n') : [])
function fakeStarts(id) {
  return fakeLines()
    .filter((l) => l.includes(` ${id.slice(0, 8)} start `))
    .map((l) => JSON.parse(l.slice(l.indexOf(' start ') + 7)))
}

async function launch() {
  const executablePath = APP ?? require('electron')
  const appArgs = [...(APP ? [] : [REPO]), `--user-data-dir=${userData}`, '--use-mock-keychain']
  const app = await _electron.launch({ executablePath, args: appArgs, env, cwd: work })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const cdp = await page.context().newCDPSession(page)
  return { app, page, cdp }
}

const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
const KEYS = {
  a: [65, 'KeyA'], b: [66, 'KeyB'], c: [67, 'KeyC'], f: [70, 'KeyF'], n: [78, 'KeyN'], p: [80, 'KeyP'],
  r: [82, 'KeyR'], v: [86, 'KeyV'], w: [87, 'KeyW'],
  1: [49, 'Digit1'], 2: [50, 'Digit2'], 3: [51, 'Digit3'],
  ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'], Escape: [27, 'Escape'],
}
/**
 * One key press through the DevTools protocol, so the modifiers and the character
 * are exactly what a Mac keyboard would send: `press(cdp, 'alt', '3', '#')` is
 * Option+3 on a Turkish-PC layout.
 */
async function press(cdp, mods, k, text) {
  const [vk, code] = KEYS[k]
  const m = (mods ? mods.split('+') : []).reduce((s, x) => s | MODS[x], 0)
  const key = text ?? (k.length === 1 ? (m & MODS.shift ? k.toUpperCase() : k) : k)
  const plain = !(m & (MODS.ctrl | MODS.meta))
  await cdp.send('Input.dispatchKeyEvent', {
    type: text !== undefined || (plain && k.length === 1) ? 'keyDown' : 'rawKeyDown',
    modifiers: m,
    key,
    code,
    windowsVirtualKeyCode: vk,
    ...(text !== undefined || (plain && k.length === 1) ? { text: key, unmodifiedText: key } : {}),
  })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: m, key, code, windowsVirtualKeyCode: vk })
  await sleep(150)
}

/** A minimal one-page PDF with `text` on it. */
function makePdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  ]
  const stream = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return pdf
}

async function main() {
  log(`terminator mac e2e — ${label}, work folder ${work}`)
  const savedClipboard = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout
  let { app, page, cdp } = await launch()
  try {
    ;({ app, page, cdp } = await suite(app, page, cdp))
  } finally {
    await app.close().catch(() => {})
    spawnSync('pbcopy', [], { input: savedClipboard })
  }
  log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

async function suite(app, page, cdp) {
  check('control.json written', await waitFor(() => fs.existsSync(path.join(userData, 'control.json')), 20_000))

  const screen = (name) =>
    page.evaluate((n) => document.querySelector(`[data-pane-session="${n}"] .xterm-rows`)?.textContent ?? '', name)
  const focusedPane = () =>
    page.evaluate(() => document.querySelector('[data-pane-focused="1"]')?.getAttribute('data-pane-session') ?? null)
  const sessions = () => JSON.parse(t('list', '--json').out || '{"sessions":[]}').sessions
  const byName = (name) => sessions().find((s) => s.name === name)
  const status = (name) => byName(name)?.status
  /** A shell session, opened from its row into the focused pane, with its prompt up. */
  async function shell(name, project = proj) {
    const r = t('new', 'shell', '--project', project, '--name', name)
    if (r.code !== 0) throw new Error(`new shell ${name}: ${r.err}`)
    await page.click(`.cc-row:has-text("${name}")`)
    await page.waitForSelector(`[data-pane-session="${name}"] .xterm`)
    await waitFor(async () => (await screen(name)).trim().length > 0, 10_000)
    await sleep(800)
    await page.click(`[data-pane-session="${name}"] .xterm`)
    return r.out
  }
  /** Bring a session's pane on screen (a reload closes them) and click into it. */
  async function showPane(name) {
    if (!(await page.$(`[data-pane-session="${name}"] .xterm`))) await page.click(`.cc-row:has-text("${name}")`)
    await page.waitForSelector(`[data-pane-session="${name}"] .xterm`)
    await sleep(500)
    await page.click(`[data-pane-session="${name}"] .xterm`)
  }
  async function typeLine(text) {
    await cdp.send('Input.insertText', { text })
    await page.keyboard.press('Enter')
  }
  const probes = async (name) => [...(await screen(name)).matchAll(/<([0-9a-f]+)>/g)].map((m) => m[1])
  /** The bytes the probe got for one key press — '' when it got none. */
  async function probeKey(name, mods, k, text) {
    const before = (await probes(name)).length
    await press(cdp, mods, k, text)
    await sleep(250)
    return (await probes(name)).slice(before).join('')
  }
  const visible = (selector) => page.evaluate((s) => !!document.querySelector(s), selector)
  /** A dialog (New session, Settings, …) is up over the panes. */
  const modalUp = () =>
    page.evaluate(() => [...document.querySelectorAll('div')].some((d) => d.style.position === 'fixed' && d.style.zIndex === '50'))
  // Notes opens on its Preview tab, so its own Edit/Preview toggle is what marks it.
  const notesOpen = () => page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Preview'))
  const clip = {
    text: () => app.evaluate(({ clipboard }) => clipboard.readText()),
    write: (text) => app.evaluate(({ clipboard }, x) => clipboard.writeText(x), text),
  }

  // ---- A. environment ---------------------------------------------------------
  let envShell
  if (run('A')) {
    const mainPath = await waitFor(
      () => app.evaluate(() => (process.env.PATH.includes('/rc-bin') ? process.env.PATH : null)),
      15_000,
    )
    check('main process gets the login shell PATH (.zshrc and .zprofile)', !!mainPath && mainPath.includes('/zp-bin'), mainPath ?? (await app.evaluate(() => process.env.PATH)))

    envShell = await shell('env')
    await typeLine(
      'echo "Z=${FROM_ZPROFILE:-0} R=${FROM_ZSHRC:-0} L=${LANG:-none} T=${TERM_PROGRAM:-none} S=${TERM_SESSION_ID:-none} LOGIN=$([[ -o login ]] && echo yes || echo no) W=$(command -v terminator >/dev/null && echo yes || echo no)"',
    )
    const line = await waitFor(async () => /Z=\d R=\d L=\S+ T=\S+ S=\S+ LOGIN=\w+ W=\w+/.exec(await screen('env'))?.[0], 10_000)
    check('a shell pane is a login shell that read .zprofile and .zshrc', /Z=1 R=1 /.test(line ?? '') && /LOGIN=yes/.test(line ?? ''), line)
    check('... with a UTF-8 LANG', /L=\w+\.UTF-8/.test(line ?? ''), line)
    check("... and none of the launching terminal's variables", /T=none S=none/.test(line ?? ''), line)
    check('... and `terminator` on its PATH', /W=yes/.test(line ?? ''), line)
    await typeLine('clear')
    await sleep(300)
    await cdp.send('Input.insertText', { text: 'echo ş-İ-ğ' })
    await sleep(400)
    const typed = await screen('env')
    check('Turkish letters typed at the prompt stay letters', typed.includes('echo ş-İ-ğ'), typed.slice(-80))
    await page.keyboard.press('Enter')
  }

  // ---- B. start failures -------------------------------------------------------
  if (run('B')) {
    await page.evaluate(() => window.terminator.updateSettings({ defaultShell: '/nope/zsh' }))
    t('new', 'shell', '--project', proj, '--name', 'broken')
    const st = await waitFor(() => (status('broken') === 'error' ? 'error' : null), 8_000)
    check('a shell that cannot start ends in error, not stuck', st === 'error', byName('broken'))
    await page.evaluate(() => window.terminator.updateSettings({ defaultShell: '/bin/zsh' }))
    const b = byName('broken')
    if (b) t('remove', b.id)
  }

  // ---- C. keyboard -----------------------------------------------------------
  if (run('C')) {
    await shell('other')
    await shell('keys')
    await typeLine(`node '${probeJs}'`)
    check('the key probe is up', !!(await waitFor(async () => (await screen('keys')).includes('PROBE-READY'), 10_000)))

    check('Option+3 (#) reaches the program', (await probeKey('keys', 'alt', '3', '#')) === '23')
    check('... and switches no session', (await focusedPane()) === 'keys', await focusedPane())
    check('Ctrl+C with nothing selected interrupts', (await probeKey('keys', 'ctrl', 'c')) === '03')
    check('Ctrl+V reaches the program', (await probeKey('keys', 'ctrl', 'v')) === '16')
    check('Ctrl+N reaches the program', (await probeKey('keys', 'ctrl', 'n')) === '0e')
    check('... and opens no dialog', !(await visible('input[placeholder="~/code/my-project"]')))
    check('Ctrl+B reaches the program', (await probeKey('keys', 'ctrl', 'b')) === '02')
    check('Option+B is a character while Option-as-Meta is off', (await probeKey('keys', 'alt', 'b', '∫')) === 'e288ab')

    await clip.write('pasted')
    check('Cmd+V pastes the clipboard', Buffer.from((await probeKey('keys', 'meta', 'v')) || '', 'hex').toString() === 'pasted')

    // Select the probe's banner with a double-click, then copy it.
    const box = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-pane-session="keys"] .xterm-rows > div')].find((d) => d.textContent.includes('PROBE-READY'))
      const r = row?.getBoundingClientRect()
      return r ? { x: r.left + 20, y: r.top + r.height / 2 } : null
    })
    if (box) await page.mouse.dblclick(box.x, box.y)
    await sleep(300)
    await clip.write('before')
    const sent = await probeKey('keys', 'meta', 'c')
    check('Cmd+C copies the selection', (await clip.text()) === 'PROBE-READY', await clip.text())
    check('... and sends nothing to the program', sent === '', sent)
    if (box) await page.mouse.dblclick(box.x, box.y)
    await sleep(300)
    check('Ctrl+C interrupts even with a selection', (await probeKey('keys', 'ctrl', 'c')) === '03')
    if (box) await page.mouse.dblclick(box.x, box.y)
    await sleep(300)
    await clip.write('before')
    if (box) await page.mouse.click(box.x, box.y, { button: 'right' })
    await sleep(400)
    const selected = await page.evaluate(() => document.querySelectorAll('[data-pane-session="keys"] .xterm-selection div').length)
    check('right-click copies the selection', (await clip.text()) === 'PROBE-READY', await clip.text())
    check('... and leaves nothing selected', selected === 0, selected)

    await press(cdp, 'meta', 'n')
    check('Cmd+N opens New session with a terminal focused', !!(await waitFor(() => visible('input[placeholder="~/code/my-project"]'), 2_000)))
    // The first Esc may only close the dialog's project list.
    for (let i = 0; i < 3 && (await modalUp()); i++) await press(cdp, '', 'Escape')
    await page.click('[data-pane-session="keys"] .xterm')
    const hadHide = await visible('button[title^="Hide sidebar"]')
    await press(cdp, 'meta', 'b')
    check('Cmd+B toggles the sidebar with a terminal focused', (await visible('button[title^="Hide sidebar"]')) !== hadHide)
    await press(cdp, 'meta', 'b')
    await page.click('[data-pane-session="keys"] .xterm')

    const slots = await page.evaluate(() => [...document.querySelectorAll('.cc-row')].map((r) => r.textContent))
    const otherSlot = slots.findIndex((s) => s.includes('other')) + 1
    const keysSlot = slots.findIndex((s) => s.includes('keys')) + 1
    if (otherSlot > 0 && otherSlot <= 3 && keysSlot > 0 && keysSlot <= 3) {
      await press(cdp, 'meta', String(otherSlot))
      check(`Cmd+${otherSlot} switches to that session`, (await focusedPane()) === 'other', await focusedPane())
      await press(cdp, 'meta', String(keysSlot))
      check(`Cmd+${keysSlot} switches back`, (await focusedPane()) === 'keys', await focusedPane())
    } else note(`session slots out of reach: ${JSON.stringify(slots)}`)
    await page.click('[data-pane-session="keys"] .xterm')
    await press(cdp, 'alt', 'ArrowDown')
    const stepped = await focusedPane()
    check('Option+↓ steps to another session', stepped && stepped !== 'keys', stepped)
    await press(cdp, 'alt', 'ArrowUp')
    check('Option+↑ steps back', (await focusedPane()) === 'keys', await focusedPane())

    await press(cdp, 'meta+shift', 'n')
    check('Cmd+Shift+N opens Notes', !!(await waitFor(notesOpen, 2_000)))
    // Notes leaves the keyboard where it was (on every platform), so Esc would go to the terminal.
    await page.evaluate(() => document.activeElement?.blur())
    await press(cdp, '', 'Escape')
    await sleep(300)
    await page.click('[data-pane-session="keys"] .xterm')
    await press(cdp, 'ctrl+shift', 'n')
    check('Ctrl+Shift+N does not', !(await notesOpen()))

    // Ctrl+click on a link is the Mac's right-click: the link menu, not the link.
    await showPane('other')
    await typeLine('clear; echo https://x.io/cc')
    await sleep(800)
    const link = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-pane-session="other"] .xterm-rows > div')]
      const row = rows.filter((d) => d.textContent.startsWith('https://x.io/cc')).pop()
      const r = row?.getBoundingClientRect()
      return r ? { x: r.left + 20, y: r.top + r.height / 2 } : null
    })
    if (link) {
      await page.mouse.move(link.x, link.y)
      await sleep(300)
      for (const type of ['mousePressed', 'mouseReleased'])
        await cdp.send('Input.dispatchMouseEvent', { type, x: link.x, y: link.y, button: 'left', clickCount: 1, modifiers: MODS.ctrl })
      await sleep(400)
    }
    const menu = await page.evaluate(() =>
      [...document.querySelectorAll('div')].some((d) => d.style.zIndex === '80' && d.textContent.includes('https://x.io/cc')),
    )
    check('Ctrl+click on a link opens the link menu', !!link && menu, link)
    await page.mouse.click(5, 300)
    await sleep(300)

    // Option as Meta, once Settings says so (the probe is still running in the pty).
    await page.evaluate(() => window.terminator.updateSettings({ optionAsMeta: true }))
    await page.reload()
    await page.click('.cc-row:has-text("keys")')
    await page.waitForSelector('[data-pane-session="keys"] .xterm', { timeout: 15_000 })
    await sleep(1000)
    await page.click('[data-pane-session="keys"] .xterm')
    check('with Option as Meta on, Option+B sends ESC b', (await probeKey('keys', 'alt', 'b', '∫')) === '1b62')
    await page.evaluate(() => window.terminator.updateSettings({ optionAsMeta: false }))
    if (await notesOpen()) {
      await page.evaluate(() => document.activeElement?.blur())
      await press(cdp, '', 'Escape')
    }
  }

  // ---- D. menu and window ----------------------------------------------------
  if (run('D')) {
    const menu = await app.evaluate(({ Menu }) => {
      const roles = []
      const walk = (m) => {
        for (const i of m?.items ?? []) {
          if (i.role) roles.push(i.role.toLowerCase())
          walk(i.submenu)
        }
      }
      walk(Menu.getApplicationMenu())
      return roles
    })
    for (const want of ['about', 'hide', 'quit', 'copy', 'paste', 'selectall', 'undo', 'minimize', 'close', 'togglefullscreen'])
      check(`the menu has ${want}`, menu.includes(want), menu)
    for (const not of ['reload', 'forcereload', 'zoomin', 'zoomout', 'resetzoom'])
      check(`the menu has no ${not}`, !menu.includes(not), menu)
    check('the show/hide hotkey is registered', await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('F12')))

    if (!byName('env')) envShell = await shell('env')
    await showPane('env')
    await typeLine('clear; sleep 2; echo while-$((6*7))-hidden')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await sleep(500)
    const w = await app.evaluate(({ BrowserWindow }) => {
      const all = BrowserWindow.getAllWindows()
      return { count: all.length, visible: all[0] ? all[0].isVisible() : null }
    })
    check('closing the window hides it', w.count === 1 && w.visible === false, w)
    await sleep(2500)
    await app.evaluate(({ app }) => app.emit('activate'))
    await sleep(800)
    check('the Dock brings it back', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    check('... with output printed while hidden', (await screen('env')).includes('while-42-hidden'), (await screen('env')).slice(-120))
  }

  // ---- E. transcripts on symlinked and miscased paths ---------------------------
  if (run('E')) {
    for (const [what, project] of [
      ['a symlinked folder', linkProj],
      ['a folder typed in the wrong case', realProj.replace('Real-Proj', 'real-proj')],
    ]) {
      const name = what.includes('symlink') ? 'linked' : 'cased'
      let r = t('new', 'claude', '--project', project, '--name', name)
      const id = r.out
      if (!check(`claude in ${what}: new`, r.code === 0, r)) continue
      const start = await waitFor(() => fakeStarts(id)[0], 15_000)
      check(`claude in ${what}: started through the login shell`, start?.env.FROM_ZSHRC === '1' && start?.env.FROM_ZPROFILE === '1', start)
      if (what.includes('symlink')) {
        check('... with LANG set', /\.UTF-8$/.test(start?.env.LANG ?? ''), start?.env.LANG)
        check("... without the terminal's TERM_PROGRAM", !start?.env.TERM_PROGRAM, start?.env.TERM_PROGRAM)
        check('... and without ELECTRON_RUN_AS_NODE', !start?.env.ELECTRON_RUN_AS_NODE, start?.env.ELECTRON_RUN_AS_NODE)
      }
      r = t('send', id, `hello from ${name}`)
      check(`claude in ${what}: send`, r.code === 0, r)
      r = t('wait', id, 'idle', 'error', '--timeout', '30s')
      check(`claude in ${what}: the turn ends idle (hooks reached the app)`, r.out === 'idle', r)
      r = t('reply', id)
      check(`claude in ${what}: reply finds the transcript`, r.out.startsWith(`Reply to: hello from ${name}`), r)
      const conv = await page.evaluate((x) => window.terminator.readConversation(x, 0), id)
      check(`claude in ${what}: the conversation view finds it too`, JSON.stringify(conv).includes(`hello from ${name}`), JSON.stringify(conv).slice(0, 160))
      t('stop', id)
      await waitFor(() => (status(name) === 'closed' ? 1 : 0), 10_000)
      await page.evaluate((x) => window.terminator.startSession(x), id)
      const again = await waitFor(() => fakeStarts(id)[1], 15_000)
      check(`claude in ${what}: a relaunch resumes the conversation`, again?.resume === true, again)
      t('stop', id)
    }
    // The conversation view's composer.
    const conv = byName('linked')
    if (conv) {
      await page.evaluate((x) => window.terminator.startSession(x), conv.id)
      await waitFor(() => status('linked') === 'idle', 15_000)
      if (!(await page.$('[data-pane-session="linked"]'))) await page.click('.cc-row:has-text("linked")')
      await page.click('[data-pane-session="linked"] button[title^="Read this conversation"]')
      const box = 'textarea[placeholder^="Message linked"]'
      await page.waitForSelector(box, { timeout: 5_000 })
      await page.click(box)
      await app.evaluate(({ clipboard, nativeImage }) =>
        clipboard.write({ text: 'plain words', image: nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==') }),
      )
      await press(cdp, 'meta+shift', 'v')
      check('Cmd+Shift+V in the composer pastes the text', (await page.$eval(box, (t) => t.value)) === 'plain words', await page.$eval(box, (t) => t.value))
      await page.fill(box, '')
      const a = path.join(realProj, 'small.txt')
      spawnSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); var pb = $.NSPasteboard.generalPasteboard; pb.clearContents;
        pb.writeObjects($([$.NSURL.fileURLWithPath('${a}')]));
        pb.setDataForType($.NSWorkspace.sharedWorkspace.iconForFile('${a}').TIFFRepresentation, $.NSPasteboardTypeTIFF); 'ok'`])
      await page.click(box)
      // Paste the way the Edit menu does it (synthetic keys never reach the menu).
      await app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.paste())
      const chip = await waitFor(
        () => page.evaluate(() => (document.querySelector('[data-conversation-for]')?.textContent ?? '').includes('small.txt')),
        5_000,
      )
      check('a file copied in Finder pastes into the composer as that file', !!chip)
      await page.click(box)
      await press(cdp, 'meta', 'f')
      check('Cmd+F finds in the conversation', !!(await waitFor(() => visible('[data-pane-session="linked"] input[placeholder="Find"]'), 2_000)))
      await press(cdp, '', 'Escape')
      t('stop', conv.id)
    }

    // Branching a conversation carries its transcript over, from the real folder.
    const parent = byName('linked')
    if (parent) {
      const prompts = await page.evaluate((x) => window.terminator.listPrompts(x), parent.id)
      check('the branch points are listed', prompts.length >= 1, prompts)
      const b = await page.evaluate(
        (x) => window.terminator.branchSession({ parentId: x, cutBeforeUuid: null, keptPrompts: 1, name: 'branched' }),
        parent.id,
      )
      check('a branch is made', b.ok, b)
      if (b.ok) {
        const conv = await page.evaluate((x) => window.terminator.readConversation(x, 0), b.session.id)
        check('... and carries the conversation', JSON.stringify(conv).includes('hello from linked'), JSON.stringify(conv).slice(0, 160))
      }
    }

    // A worktree, from a project behind a symlink.
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: realProj })
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: realProj })
    let w = t('new', 'shell', '--project', linkProj, '--name', 'wt', '--worktree', '--branch', 'feat-mac')
    const wt = byName('wt')
    check('a worktree session is made', w.code === 0 && !!wt && wt.branch === 'feat-mac', { w, wt })
    if (wt) {
      t('stop', wt.id)
      await waitFor(() => (status('wt') === 'closed' ? 1 : 0), 10_000)
      w = t('remove', wt.id, '--remove-worktree')
      const left = spawnSync('git', ['worktree', 'list'], { cwd: realProj, encoding: 'utf8' }).stdout
      check('... and removed with its worktree', w.code === 0 && !left.includes('feat-mac'), { w, left })
    }

    // Claude prints the real path; a click on it must still resolve inside the folder.
    const linked = byName('linked')
    if (linked) {
      const real = fs.realpathSync.native(path.join(realProj, 'small.txt'))
      const hit = await page.evaluate(([id, p]) => window.terminator.resolveOutputPath(id, p), [linked.id, real])
      check('a real path printed in a symlinked project is a link', !!hit, { real, hit })
    }
  }

  // ---- F. launching .app bundles -------------------------------------------------
  if (run('F')) {
    let r = await page.evaluate(() => window.terminator.openLink('https://example.com/a?b=1', 'stub'))
    const got = await waitFor(() => fs.existsSync(browserLog) && fs.readFileSync(browserLog, 'utf8'), 5_000)
    check('a browser picked as an .app opens, with its arguments', r.ok && /launched --incognito https:\/\/example\.com\/a\?b=1/.test(got || ''), { r, got })
    fs.rmSync(browserLog, { force: true })
    r = await page.evaluate(() => window.terminator.openLink('https://example.com/plain', 'stub-plain'))
    const plain = await waitFor(() => fs.existsSync(browserLog) && fs.readFileSync(browserLog, 'utf8'), 8_000)
    check('an .app with no arguments opens through Launch Services', r.ok && /launched/.test(plain || ''), { r, plain })
    r = await page.evaluate(() => window.terminator.openLink('https://example.com/', 'nope'))
    check('a missing .app says so', r.ok === false, r)

    const sh = byName('env') ?? byName('keys') ?? byName('other')
    if (sh) {
      fs.rmSync(editorLog, { force: true })
      r = await page.evaluate(([id, p]) => window.terminator.openFileInEditor({ sessionId: id, path: p, line: 3 }), [sh.id, path.join(proj, 'small.txt')])
      const ed = await waitFor(() => fs.existsSync(editorLog) && fs.readFileSync(editorLog, 'utf8'), 5_000)
      check('an editor picked as an .app gets -g {path}:{line}', r.ok && (ed || '').includes(`-g ${fs.realpathSync(proj)}/small.txt:3`) || (ed || '').includes(`-g ${proj}/small.txt:3`), { r, ed })
      // A bare command name resolves on the login shell's PATH, not launchd's.
      await page.evaluate(() =>
        window.terminator.updateSettings({ projectEditor: { command: 'fake-editor', args: ['--folder', '{path}'] } }),
      )
      fs.rmSync(editorLog, { force: true })
      r = await page.evaluate((id) => window.terminator.openProjectEditor(id), sh.id)
      const pe = await waitFor(() => fs.existsSync(editorLog) && fs.readFileSync(editorLog, 'utf8'), 5_000)
      check('a project editor named by command is found on the shell PATH', r.ok && /--folder /.test(pe || ''), { r, pe })
      await page.evaluate(() =>
        window.terminator.updateSettings({ projectEditor: { command: 'open', args: ['-a', 'Nope Nope Editor'] } }),
      )
      r = await page.evaluate((id) => window.terminator.openProjectEditor(id), sh.id)
      check('`open -a` for an app that isn\'t there says so', r.ok === false, r)
    }
  }

  // ---- G. a file copied in Finder --------------------------------------------------
  if (run('G')) {
    const a = path.join(proj, 'small.txt')
    const b = path.join(proj, 'with space.txt')
    fs.writeFileSync(b, 'z')
    // What Finder's Cmd+C leaves: the files' URLs, their names as text, and an icon.
    const jxa = `ObjC.import('AppKit'); var pb = $.NSPasteboard.generalPasteboard; pb.clearContents;
      pb.writeObjects($([$.NSURL.fileURLWithPath('${a}'), $.NSURL.fileURLWithPath('${b}')]));
      pb.setDataForType($.NSWorkspace.sharedWorkspace.iconForFile('${a}').TIFFRepresentation, $.NSPasteboardTypeTIFF); 'ok'`
    spawnSync('osascript', ['-l', 'JavaScript', '-e', jxa])
    check('the clipboard holds an icon image (the trap is set)', await app.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()))
    if (!byName('paste')) await shell('paste')
    await showPane('paste')
    await typeLine('clear')
    await sleep(300)
    await press(cdp, 'meta', 'v')
    await sleep(800)
    const s = await screen('paste')
    check('Cmd+V of Finder files types their paths', s.includes('small.txt') && s.includes('with space.txt'), s.slice(-160))
    const pngs = fs.existsSync(path.join(userData, 'attachments'))
      ? fs.readdirSync(path.join(userData, 'attachments')).filter((f) => f.endsWith('.png'))
      : []
    check('... and attaches no picture of the icon', pngs.length === 0, pngs)
    await press(cdp, 'ctrl', 'c')
  }

  // ---- H. panes, theme, title bar, restart ------------------------------------
  if (run('H')) {
    // A reload leaves one empty pane, so each pane below gets the whole window.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await sleep(1500)
    const server = http.createServer((_q, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<title>local page</title><p>hello from the local page</p>')
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${server.address().port}/`
    const pdfFile = path.join(proj, 'doc.pdf')
    fs.writeFileSync(pdfFile, makePdf('Hello PDF'))

    const open = async (input, name) => {
      const s = await page.evaluate((i) => window.terminator.createSession(i), { ...input, name, projectPath: proj, mode: 'normal' })
      await page.click(`.cc-row:has-text("${name}")`)
      await sleep(1500)
      return s
    }

    await open({ kind: 'editor' }, 'files')
    const tree = await page.evaluate(() => document.querySelector('[data-pane-session="files"]')?.textContent ?? '')
    check('an editor pane lists the project', tree.includes('small.txt'), tree.slice(0, 200))
    check('... without .DS_Store', !tree.includes('.DS_Store'))
    await page.click(`[data-pane-session="files"] >> text=small.txt`)
    await sleep(800)
    await page.click('[data-pane-session="files"] .cm-content')
    await waitFor(() => page.evaluate(() => !!document.activeElement?.closest('[data-pane-focused="1"] .cm-editor')), 3_000)
    // The editor takes focus once its file has loaded, which closes a Quick Open opened
    // a moment before — so a press that loses that race is made again.
    let qo = false
    for (let i = 0; i < 3 && !qo; i++) {
      await press(cdp, 'meta', 'p')
      qo = !!(await waitFor(() => visible('input[placeholder^="Search files by name"]'), 1_500))
    }
    check('Cmd+P opens Quick Open in an editor pane', qo, qo ? undefined : await page.evaluate(() => ({ active: document.activeElement?.className, focused: document.querySelector('[data-pane-focused="1"]')?.getAttribute('data-pane-session') })))
    await press(cdp, '', 'Escape')
    await sleep(300)
    await page.click('[data-pane-session="files"] .cm-content')
    await press(cdp, 'ctrl', 'p')
    check('Ctrl+P leaves it to the editor', !(await visible('input[placeholder^="Search files by name"]')))

    await open({ kind: 'browser', url }, 'web')
    const loaded = await waitFor(
      () => app.evaluate(({ webContents }, u) => webContents.getAllWebContents().some((w) => w.getURL() === u && !w.isLoading()), url),
      10_000,
    )
    check('a browser pane loads a local page', !!loaded)
    const guest = (js) =>
      app.evaluate(({ webContents }, [u, code]) => webContents.getAllWebContents().find((w) => w.getURL() === u)?.executeJavaScript(code), [url, js])
    const reloaded = async (fire) => {
      await guest('window.__mark = 1')
      await fire()
      return waitFor(async () => (await guest('window.__mark === undefined && document.readyState === "complete"')) === true, 5_000)
    }
    check(
      'Cmd+R in a web page reloads it',
      !!(await reloaded(() =>
        app.evaluate(({ webContents }, u) => {
          const g = webContents.getAllWebContents().find((w) => w.getURL() === u)
          g.focus()
          g.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['meta'] })
          g.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['meta'] })
        }, url),
      )),
    )
    await page.click('[data-pane-session="web"] input[placeholder="Type an address"]')
    check('... and from the address bar', !!(await reloaded(() => press(cdp, 'meta', 'r'))))
    await page.click('[data-pane-session="web"] input[placeholder="Type an address"]')
    await press(cdp, 'meta', 'f')
    check('Cmd+F finds in a browser pane', !!(await waitFor(() => visible('[data-pane-session="web"] input[placeholder="Find"]'), 2_000)))
    await press(cdp, '', 'Escape')
    const guestKey = await app.evaluate(async ({ webContents }, u) => {
      const g = webContents.getAllWebContents().find((w) => w.getURL() === u)
      if (!g) return 'no guest'
      g.focus()
      g.sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['meta'] })
      g.sendInputEvent({ type: 'keyUp', keyCode: '1', modifiers: ['meta'] })
      return 'sent'
    }, url)
    await sleep(800)
    const after = await focusedPane()
    check('Cmd+1 switches session from inside a web page', guestKey === 'sent' && after !== 'web', { guestKey, after })

    await open({ kind: 'pdf', file: pdfFile }, 'doc')
    const pdfOk = await waitFor(
      () => page.evaluate(() => (document.querySelector('[data-pane-session="doc"]')?.textContent ?? '').includes('Hello PDF')),
      10_000,
    )
    check('a PDF pane renders the document', !!pdfOk)
    server.close()

    const pos = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getWindowButtonPosition?.() ?? null)
    const bar = await page.evaluate(() => {
      const strip = document.querySelector('#root > div > div')
      return strip ? { text: strip.textContent, height: strip.getBoundingClientRect().height } : null
    })
    check('the title bar is drawn in the theme, traffic lights inset', !!pos && bar?.text === 'Terminator' && pos.y > 6, { pos, bar })
    await page.evaluate(() => window.terminator.updateSettings({ theme: 'github-light' }))
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await sleep(1500)
    check('a theme applies', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'github-light')
  }

  // ---- restart: what the app remembers -----------------------------------------
  if (run('H')) {
    const before = sessions().map((s) => s.name).sort()
    await app.close()
    ;({ app, page, cdp } = await launch())
    await waitFor(() => fs.existsSync(path.join(userData, 'control.json')), 20_000)
    const after = sessions().map((s) => s.name).sort()
    check('sessions survive a restart', JSON.stringify(after) === JSON.stringify(before), { before, after })
    check('... and so does the theme', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'github-light')
  }

  // ---- A, slow: a login shell that takes forever doesn't hold the app up -------------
  if (run('A') && !QUICK) {
    await app.close()
    zshrc('[[ -n $TERMINATOR_RESOLVING_ENVIRONMENT ]] && sleep 30')
    const t0 = Date.now()
    ;({ app, page, cdp } = await launch())
    const up = await waitFor(() => fs.existsSync(path.join(userData, 'control.json')), 20_000)
    check('a slow .zshrc does not delay the window', up && Date.now() - t0 < 8_000, `${Date.now() - t0} ms`)
    const p = await waitFor(() => app.evaluate(() => (process.env.PATH.includes('/usr/local/bin') ? process.env.PATH : null)), 15_000)
    check('... and main falls back to the usual folders', !!p, p)
    zshrc()
  }
  return { app, page, cdp }
}

main().catch((e) => {
  log(`FAIL  crashed: ${e.stack || e}`)
  process.exit(1)
})
