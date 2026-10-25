// The packaged app, opened the way the Dock opens it, running the real `claude`:
// what test/mac/e2e.js can only approximate with a stand-in. It uses your own
// shell setup and your Claude account (a few short prompts), with a throwaway app
// profile, so your Terminator sessions and settings are left alone. Claude does
// remember the temp project folder as one it was asked to trust.
//
//   npm run dist:mac && node test/mac/real-claude.js
//
//   TERMINATOR_APP_BUNDLE=<.app>   default release/mac-arm64/Terminator.app

const { chromium } = require('playwright-core')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const BUNDLE = path.resolve(process.env.TERMINATOR_APP_BUNDLE || path.join(REPO, 'release', 'mac-arm64', 'Terminator.app'))
const PORT = 9339
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'terminator-real-'))
const userData = path.join(work, 'userdata')
const proj = path.join(work, 'proj')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(proj, { recursive: true })
fs.writeFileSync(path.join(proj, 'hello.txt'), 'hello\n')
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    scripting: true,
    promptEditorId: 'in-app',
    modes: {
      normal: { command: 'claude', extraArgs: [] },
      readonly: { command: 'claude', extraArgs: ['--permission-mode', 'plan'] },
    },
  }),
)

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  const d = detail === undefined ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d}`)
  return ok
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms, step = 300) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) {
    const v = await fn()
    if (v) return v
  }
  return fn()
}
function t(...a) {
  const r = spawnSync(path.join(userData, 'bin', 'terminator'), a, { encoding: 'utf8', cwd: proj, timeout: 300_000 })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
const appPids = () =>
  (spawnSync('pgrep', ['-f', `user-data-dir=${userData}`], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean)

async function main() {
  console.log(`real-claude — ${BUNDLE}, work folder ${work}`)
  // Through Launch Services, so the app gets launchd's environment, not this shell's.
  spawnSync('open', ['-n', '-a', BUNDLE, '--args', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`])
  check('control.json written', !!(await waitFor(() => fs.existsSync(path.join(userData, 'control.json')), 30_000)))
  const browser = await waitFor(() => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null), 20_000, 1000)
  const page = browser.contexts()[0].pages().find((p) => p.url().startsWith('file:'))
  try {
    await run(page)
  } finally {
    await browser.close().catch(() => {})
    for (const pid of appPids()) spawnSync('kill', [pid])
    await waitFor(() => appPids().length === 0, 15_000)
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

async function run(page) {
  const screen = (name) =>
    page.evaluate((n) => document.querySelector(`[data-pane-session="${n}"] .xterm-rows`)?.textContent ?? '', name)
  /** Bring a session's pane back on screen (an Editor tab may have taken its place) and click into it. */
  async function showPane(name) {
    if (!(await page.$(`[data-pane-session="${name}"] .xterm`))) await page.click(`.cc-row:has-text("${name}")`)
    await page.waitForSelector(`[data-pane-session="${name}"] .xterm`)
    await sleep(500)
    await page.click(`[data-pane-session="${name}"] .xterm`)
  }
  const status = (id) => JSON.parse(t('list', '--json').out || '{"sessions":[]}').sessions.find((s) => s.id === id)?.status

  // ---- a shell, as a Dock-launched app starts it ----------------------------------
  let r = t('new', 'shell', '--project', proj, '--name', 'sh', '--split', 'right')
  await page.waitForSelector('[data-pane-session="sh"] .xterm')
  await sleep(2500)
  await page.click('[data-pane-session="sh"] .xterm')
  await page.keyboard.type('clear; echo "N=$(command -v node) C=$(command -v claude) B=$(command -v brew) L=$LANG"')
  await page.keyboard.press('Enter')
  const line = await waitFor(async () => /N=\S* C=\S* B=\S* L=\S*/.exec(await screen('sh'))?.[0], 10_000)
  check('the shell finds node and claude (nvm, from .zshrc)', /N=\/\S+ C=\/\S+/.test(line ?? ''), line)
  check('... Homebrew', /B=\/\S+/.test(line ?? ''), line)
  check('... and has a UTF-8 LANG', /L=\S+\.UTF-8/.test(line ?? ''), line)

  // ---- a real Claude session -----------------------------------------------------
  r = t('new', 'claude', '--project', proj, '--name', 'real', '--split', 'right')
  const id = r.out
  check('new claude', r.code === 0, r)
  await page.waitForSelector('[data-pane-session="real"] .xterm')
  // A folder Claude hasn't seen asks to be trusted before anything else.
  const trust = await waitFor(async () => /trust/i.test(await screen('real')), 40_000)
  if (trust) {
    // For a temp folder the dialog's default is "No, exit".
    await page.click('[data-pane-session="real"] .xterm')
    if (/❯\s*No/.test(await screen('real'))) await page.keyboard.press('ArrowDown')
    await sleep(300)
    await page.keyboard.press('Enter')
  }
  r = t('send', id, 'Reply with exactly the word pong and nothing else.')
  if (!check('send', r.code === 0, r)) {
    console.log('SCREEN ' + (await screen('real')).slice(-1500))
    console.log('LIST ' + t('list', '--json').out)
    return
  }
  r = t('wait', id, 'idle', 'error', '--timeout', '3m')
  check('the turn ends idle (hooks reached the app)', r.out === 'idle', r)
  r = t('reply', id)
  check('reply finds the transcript in a symlinked temp folder', /pong/i.test(r.out), r)

  // What Claude's own commands inherit.
  r = t('send', id, 'Use the Bash tool to run exactly: echo "R=${ELECTRON_RUN_AS_NODE:-unset} L=$LANG" — then reply with only its output.')
  for (let i = 0; i < 4; i++) {
    r = t('wait', id, 'idle', 'waiting', 'error', '--timeout', '3m')
    if (r.out !== 'waiting') break
    await showPane('real')
    await page.keyboard.press('Enter') // allow the command
  }
  r = t('reply', id)
  check("Claude's commands don't inherit ELECTRON_RUN_AS_NODE, and have LANG", /R=unset L=\S+UTF-8/.test(r.out), r.out)

  // Ctrl+G into an in-app Editor tab, and back.
  await page.evaluate(() => {
    window.__edits = []
    window.terminator.onPromptEdit((e) => window.__edits.push(e))
  })
  await showPane('real')
  await page.keyboard.type('draft prompt')
  await page.keyboard.press('Control+g')
  const edit = await waitFor(() => page.evaluate(() => window.__edits[0] ?? null), 20_000)
  check('Ctrl+G opens the prompt in an in-app Editor tab', !!edit, edit)
  if (edit) {
    await page.evaluate((f) => window.terminator.promptEditDone(f), edit.file)
    await sleep(1500)
    await showPane('real')
    const back = await waitFor(async () => (await screen('real')).includes('draft prompt'), 10_000)
    check('... and hands it back', back, (await screen('real')).slice(-200))
  }
  await showPane('real')
  await page.keyboard.press('Control+u')

  // Read-only and back, keeping the conversation.
  await page.evaluate((x) => window.terminator.setMode(x, 'readonly'), id)
  await waitFor(() => status(id) === 'idle', 60_000)
  const conv = await page.evaluate((x) => window.terminator.readConversation(x, 0), id)
  check('switching to read-only keeps the conversation', JSON.stringify(conv).includes('pong'), JSON.stringify(conv).slice(0, 200))
  t('stop', id)
}

main().catch((e) => {
  console.log(`FAIL  crashed: ${e.stack || e}`)
  for (const pid of appPids()) spawnSync('kill', [pid])
  process.exit(1)
})
