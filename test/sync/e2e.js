// End-to-end test of Settings → SYNC (README → Syncing settings across machines),
// against the real app with throwaway profiles. It plays the part of git: it edits,
// deletes and rewrites the files in the sync folder the way a pull does while the app
// is running, and checks the app picks that up and never writes over it. Two profiles
// stand in for two computers sharing one folder.
//
//   npm run build && npm run test:sync          (Linux: under xvfb-run -a)
//
//   TERMINATOR_APP=<exe>   test a packaged build instead of out/
//   TERMINATOR_TEST_OUT    where the work folder and log go (default: the temp folder)
//
// Paths are the platform's own: `~\…` and `C:\…` on Windows, `~/…` and the temp
// folder (behind macOS's /var -> /private/var link) elsewhere.

const { _electron } = require('playwright-core')
const fs = require('fs')
const os = require('os')
const path = require('path')

const WIN = process.platform === 'win32'
const MAC = process.platform === 'darwin'
const APP = process.env.TERMINATOR_APP ? path.resolve(process.env.TERMINATOR_APP) : null
const REPO = path.resolve(__dirname, '..', '..')

const out = path.resolve(process.env.TERMINATOR_TEST_OUT || path.join(os.tmpdir(), 'terminator-sync'))
const work = path.join(out, 'work')
fs.rmSync(work, { recursive: true, force: true })
const home = path.join(work, 'home')
const userA = path.join(work, 'userdata-a')
const userB = path.join(work, 'userdata-b')
const proj = path.join(work, 'proj')
const proj2 = path.join(work, 'proj2')
for (const d of [home, userA, userB, proj, proj2]) fs.mkdirSync(d, { recursive: true })
const fake = path.join(REPO, 'test', 'scripting', 'fake-claude.js')

const syncDir = path.join(home, 'terminator-settings')
const tilde = WIN ? '~\\terminator-settings' : '~/terminator-settings'
const OS_FILE = WIN ? 'settings.windows.json' : MAC ? 'settings.macos.json' : 'settings.linux.json'
const OTHER_OS_FILE = WIN ? 'settings.macos.json' : 'settings.windows.json'
const ALLOWED = new Set(['settings.json', 'settings.windows.json', 'settings.macos.json', 'settings.linux.json', 'themes.json', 'notes.md'])
const inSync = (name) => path.join(syncDir, name)

const env = { ...process.env, HOME: home, USERPROFILE: home }
delete env.ELECTRON_RUN_AS_NODE
const logFile = path.join(work, 'e2e.log')

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** What a refused call said — the detail worth logging for a save. */
const why = (r) => (r.ok ? undefined : r.error)
async function waitFor(fn, ms = 8000, step = 200) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) {
    const v = await fn()
    if (v) return v
  }
  return fn()
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n')
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)
/** The same folder, however it's spelled — macOS's temp folder sits behind a link. */
const real = (p) => {
  try {
    return fs.realpathSync.native(p).toLowerCase()
  } catch {
    return path.resolve(p).toLowerCase()
  }
}

const LOCAL_KEYS = ['projects', 'defaultShell', 'shellArgs', 'worktreesRoot', 'gitGuiCommand', 'projectEditor', 'scripting', 'wsl', 'settingsOpen', 'syncFolder', 'notes']
const shell = WIN ? 'pwsh.exe' : '/bin/bash'
const shellArgs = WIN ? ['-NoLogo', '-NoProfile'] : ['--norc', '--noprofile', '-i']
const mode = { command: 'node', extraArgs: [fake] }
const theme = (id, name, bg) => ({ id, name, bg, dark: true })

// Computer A, as it is before anyone heard of a sync folder: one settings.json
// holding everything, and a theme of its own.
writeJson(path.join(userA, 'settings.json'), {
  theme: 'darcula',
  fontSize: 15,
  notes: 'hello from A',
  notesShortcut: 'CommandOrControl+Shift+M',
  projects: [{ name: 'proj', path: proj }],
  defaultShell: shell,
  shellArgs,
  worktreesRoot: path.join(home, 'wt-a'),
  modes: { normal: mode, readonly: mode },
  links: { browsers: [{ id: 'b1', name: 'Fake', command: path.join(home, 'fake-browser'), args: [] }], requireCtrlClick: true },
  notifications: { command: 'notify-a', triggerOn: ['waiting'], perType: {} },
})
writeJson(path.join(userA, 'themes.json'), [theme('custom-mine-a', 'Mine A', '#102030')])

// Computer B: other preferences, another theme, its own shell.
writeJson(path.join(userB, 'settings.json'), {
  theme: 'github-light',
  fontSize: 13,
  notes: 'B notes',
  defaultShell: shell,
  shellArgs,
  worktreesRoot: path.join(home, 'wt-b'),
  modes: { normal: mode, readonly: mode },
})
writeJson(path.join(userB, 'themes.json'), [theme('custom-mine-b', 'Mine B', '#203040')])

async function launch(userData) {
  const executablePath = APP ?? require('electron')
  const appArgs = [
    ...(APP ? [] : [REPO]),
    `--user-data-dir=${userData}`,
    ...(WIN ? [] : ['--no-sandbox']),
    ...(MAC ? ['--use-mock-keychain'] : []),
  ]
  const app = await _electron.launch({ executablePath, args: appArgs, env, cwd: REPO })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!document.documentElement.dataset.theme)
  return { app, page }
}

/** The calls the Settings panel makes, from the window. */
function api(page) {
  return {
    settings: () => page.evaluate(() => window.terminator.getSettings()),
    status: () => page.evaluate(() => window.terminator.getSyncStatus()),
    themes: () => page.evaluate(() => window.terminator.getCustomThemes()),
    update: (patch) =>
      page.evaluate(
        (p) =>
          window.terminator.updateSettings(p).then(
            (value) => ({ ok: true, value }),
            (e) => ({ ok: false, error: String(e?.message ?? e) }),
          ),
        patch,
      ),
    themeOp: (op) =>
      page.evaluate(
        (o) =>
          window.terminator.updateCustomThemes(o).then(
            (value) => ({ ok: true, value }),
            (e) => ({ ok: false, error: String(e?.message ?? e) }),
          ),
        op,
      ),
    painted: () => page.evaluate(() => document.documentElement.dataset.theme),
    text: () => page.evaluate(() => document.body.innerText),
  }
}

function syncListing() {
  return fs.existsSync(syncDir) ? fs.readdirSync(syncDir) : []
}

async function main() {
  log(`terminator sync e2e — ${APP ? 'packaged' : 'dev'} on ${process.platform}, work folder ${work}`)

  // ---- 1. no sync folder: nothing changes -----------------------------------
  let { app, page } = await launch(userA)
  let a = api(page)
  let s = await a.settings()
  check('legacy settings.json loads as before', s.theme === 'darcula' && s.fontSize === 15 && s.notes === 'hello from A', { theme: s.theme, fontSize: s.fontSize })
  check('sync is off', (await a.status()).dir === null && s.syncFolder === '')
  let r = await a.update({ fontSize: 16 })
  const legacy = readJson(path.join(userA, 'settings.json'))
  check('a save still writes the whole settings.json', r.ok && legacy.fontSize === 16 && 'terminalFont' in legacy && 'links' in legacy, why(r))
  check('nothing was created outside userData', !fs.existsSync(syncDir))

  // ---- 2. turning it on seeds the folder --------------------------------------
  r = await a.update({ syncFolder: tilde })
  check(`sync on with ${tilde}`, r.ok, why(r))
  const seeded = readJson(inSync('settings.json')) ?? {}
  check('settings.json seeded with the shared values', seeded.theme === 'darcula' && seeded.fontSize === 16 && seeded.notesShortcut === 'CommandOrControl+Shift+M', seeded)
  check('... and none of the local ones', LOCAL_KEYS.every((k) => !(k in seeded)), Object.keys(seeded))
  check('... nor local fields of mixed sections', !seeded.links?.browsers && !seeded.links?.editor && !seeded.notifications?.command, seeded.links)
  check('notes.md seeded', read(inSync('notes.md')) === 'hello from A')
  check('themes.json seeded', (readJson(inSync('themes.json')) ?? []).some((t) => t.id === 'custom-mine-a'))
  check('a backup of this computer settings is kept', readJson(path.join(userA, 'settings.before-sync.json'))?.theme === 'darcula')
  let status = await a.status()
  check('status points at the folder', status.dir && real(status.dir) === real(syncDir) && !status.problem && status.osFile === OS_FILE, status.files)
  const localCopy = readJson(path.join(userA, 'settings.json'))
  check('userData keeps a full copy', localCopy.syncFolder === tilde && localCopy.theme === 'darcula' && localCopy.defaultShell === shell)

  const again = WIN || MAC ? syncDir.toUpperCase() + path.sep : syncDir + path.sep
  const before = read(inSync('settings.json'))
  r = await a.update({ syncFolder: again })
  status = await a.status()
  check('the same folder spelled differently is not a switch', r.ok && real(status.dir) === real(syncDir) && read(inSync('settings.json')) === before, why(r))
  await a.update({ syncFolder: tilde })

  // ---- 3. each save goes to the right file --------------------------------------
  await a.update({ fontSize: 17 })
  check('a shared key goes to the folder', readJson(inSync('settings.json')).fontSize === 17)
  await a.update({ defaultShell: shell + ' ' })
  check('a local key stays local', !('defaultShell' in readJson(inSync('settings.json'))) && readJson(path.join(userA, 'settings.json')).defaultShell === shell + ' ')
  await a.update({ defaultShell: shell })
  await a.update({ links: { requireCtrlClick: false } })
  let synced = readJson(inSync('settings.json'))
  check('one field of a section goes alone', synced.links?.requireCtrlClick === false && !synced.links?.browsers, synced.links)
  await a.update({ links: { browsers: [{ id: 'b2', name: 'Other', command: path.join(home, 'other'), args: ['-x'] }] } })
  synced = readJson(inSync('settings.json'))
  s = await a.settings()
  check('a local field of a shared section stays local', !synced.links?.browsers && s.links.browsers[0]?.id === 'b2' && s.links.requireCtrlClick === false)
  await a.update({ notes: 'notes v2' })
  check('notes go to notes.md', read(inSync('notes.md')) === 'notes v2' && !('notes' in readJson(inSync('settings.json'))))

  // ---- 4. per-OS overrides -------------------------------------------------------
  writeJson(inSync(OS_FILE), { fontSize: 18, modes: { normal: { command: 'node' } } })
  writeJson(inSync(OTHER_OS_FILE), { fontSize: 30 })
  s = await waitFor(async () => {
    const v = await a.settings()
    return v.fontSize === 18 && v
  })
  check(`${OS_FILE} overrides, ${OTHER_OS_FILE} is ignored`, s && s.fontSize === 18, s && s.fontSize)
  check('a partial modes override keeps extraArgs', Array.isArray(s.modes?.normal?.extraArgs) && s.modes.normal.extraArgs[0] === fake, s.modes)
  await a.update({ fontSize: 19 })
  check('an overridden key is saved to the override', readJson(inSync(OS_FILE)).fontSize === 19 && readJson(inSync('settings.json')).fontSize === 17)
  const claude = await page.evaluate(
    async (p) => {
      const made = await window.terminator.createSession({ kind: 'claude', mode: 'normal', projectPath: p })
      try {
        await window.terminator.startSession(made.id, 100, 30)
        return { ok: true, id: made.id }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    },
    proj,
  )
  const started = await waitFor(() => (read(path.join(home, 'fake-claude.log')) ?? '').includes('start'), 15000)
  check('a Claude session launches with the partial override', claude.ok && started, claude)
  if (claude.ok) await page.evaluate((id) => window.terminator.stopSession(id), claude.id).catch(() => {})

  // ---- 5. a pull while running ------------------------------------------------------
  writeJson(inSync('settings.json'), { ...readJson(inSync('settings.json')), theme: 'dracula' })
  check('an edit in place reaches the window', await waitFor(async () => (await a.painted()) === 'dracula'))
  const pulled = readJson(inSync('settings.json'))
  fs.unlinkSync(inSync('settings.json'))
  await sleep(150)
  writeJson(inSync('settings.json'), { ...pulled, theme: 'one-dark' })
  check('delete-and-recreate (a git checkout) reaches the window', await waitFor(async () => (await a.painted()) === 'one-dark'))
  // Straight after a pull, before the app has had a chance to notice it.
  writeJson(inSync('settings.json'), { ...readJson(inSync('settings.json')), iconScale: 120 })
  r = await a.update({ terminalFont: 'Menlo, monospace' })
  synced = readJson(inSync('settings.json'))
  check('a save right after a pull keeps the pulled change', r.ok && synced.iconScale === 120 && synced.terminalFont === 'Menlo, monospace' && synced.theme === 'one-dark', synced)

  // ---- 6. themes --------------------------------------------------------------------
  writeJson(inSync('themes.json'), [...readJson(inSync('themes.json')), theme('custom-pulled', 'Pulled', '#334455')])
  writeJson(inSync('settings.json'), { ...readJson(inSync('settings.json')), theme: 'custom-pulled' })
  check('a pulled theme, selected by the same pull, paints', await waitFor(async () => (await a.painted()) === 'custom-pulled'))
  writeJson(inSync('themes.json'), [...readJson(inSync('themes.json')), theme('custom-late', 'Late', '#445566')])
  r = await a.themeOp({ upsert: theme('custom-mine-a', 'Mine A renamed', '#102030') })
  let ids = (readJson(inSync('themes.json')) ?? []).map((t) => t.id)
  check('a theme edit keeps a theme pulled a moment before', r.ok && ids.includes('custom-late') && ids.includes('custom-pulled'), ids)
  r = await a.themeOp({ remove: 'custom-late' })
  ids = (readJson(inSync('themes.json')) ?? []).map((t) => t.id)
  check('deleting a theme removes it from the folder', r.ok && !ids.includes('custom-late') && ids.includes('custom-mine-a'), ids)
  check('the local themes.json is a copy', (readJson(path.join(userA, 'themes.json')) ?? []).some((t) => t.name === 'Mine A renamed'))

  // ---- 7. a byte-order mark -------------------------------------------------------------
  fs.writeFileSync(inSync(OS_FILE), '\uFEFF' + JSON.stringify({ fontSize: 22 }))
  check('a file with a BOM is read', await waitFor(async () => (await a.settings()).fontSize === 22))
  check('... and is not reported as broken', !(await a.status()).problem)

  // ---- 8. a merge conflict ---------------------------------------------------------------
  const goodShared = read(inSync('settings.json'))
  const conflict = `<<<<<<< HEAD\n${goodShared}=======\n{ "theme": "dracula" }\n>>>>>>> origin/main\n`
  fs.writeFileSync(inSync('settings.json'), conflict)
  status = await waitFor(async () => {
    const v = await a.status()
    return v.problem && v
  })
  check('a conflicted settings.json is reported', !!status?.problem, status?.problem)
  check('... with a toast', await waitFor(async () => (await a.text()).includes('Settings sync')))
  s = await a.settings()
  check('... and its last good values are kept', s.theme === 'custom-pulled' && s.iconScale === 120, { theme: s.theme, iconScale: s.iconScale })
  r = await a.update({ terminalFont: 'Consolas, monospace' })
  check('a shared save is refused, saying why', !r.ok && /valid JSON/.test(r.error), r.error)
  check('... and the file is left as it was', read(inSync('settings.json')) === conflict)
  r = await a.update({ worktreesRoot: path.join(home, 'wt-a2') })
  check('a local save still works', r.ok && readJson(path.join(userA, 'settings.json')).worktreesRoot === path.join(home, 'wt-a2'), why(r))
  const made = await page.evaluate(
    (p) => window.terminator.createSession({ kind: 'shell', mode: 'normal', projectPath: p }).then((x) => !!x.id, (e) => String(e)),
    proj2,
  )
  check('a session can still be created', made === true && (await a.settings()).projects.some((p) => p.path === proj2), made)
  fs.writeFileSync(inSync('settings.json'), goodShared)
  check('fixing the file clears the problem', await waitFor(async () => !(await a.status()).problem))

  // ---- 9. only the sync files ever land in the folder --------------------------------------
  await sleep(1000)
  const listing = syncListing()
  check('the folder holds nothing but the sync files', listing.every((f) => ALLOWED.has(f)), listing)
  check('runtime state stays in userData', fs.existsSync(path.join(userA, 'sessions.json')) && !listing.includes('sessions.json'))

  // ---- 10. a restart ------------------------------------------------------------------------
  await app.close()
  ;({ app, page } = await launch(userA))
  a = api(page)
  s = await a.settings()
  check('settings survive a restart', s.theme === 'custom-pulled' && s.fontSize === 22 && s.notes === 'notes v2' && s.links.browsers[0]?.id === 'b2', { theme: s.theme, fontSize: s.fontSize })
  check('... painted from the folder', (await a.painted()) === 'custom-pulled')

  // ---- 11. the folder goes missing ------------------------------------------------------------
  await app.close()
  const away = syncDir + '-away'
  fs.renameSync(syncDir, away)
  ;({ app, page } = await launch(userA))
  a = api(page)
  s = await a.settings()
  status = await a.status()
  check('a missing folder runs on the local copy', s.theme === 'custom-pulled' && s.notes === 'notes v2' && (await a.painted()) === 'custom-pulled', s.theme)
  check('... and says so', /no settings\.json/i.test(status.problem), status.problem)
  r = await a.update({ fontSize: 25 })
  check('... and refuses shared saves', !r.ok && !fs.existsSync(syncDir), r.error)
  fs.renameSync(away, syncDir)
  check('the folder coming back is picked up', await waitFor(async () => !(await a.status()).problem))
  await app.close()

  // ---- 12. a second computer adopts the folder ------------------------------------------------
  ;({ app, page } = await launch(userB))
  const b = api(page)
  r = await b.update({ syncFolder: userB })
  check("Terminator's own data folder is refused", !r.ok, r.error)
  const foreign = path.join(home, 'not-ours')
  fs.mkdirSync(foreign)
  writeJson(path.join(foreign, 'settings.json'), { permissions: { allow: [] }, hooks: {} })
  r = await b.update({ syncFolder: foreign })
  check("someone else's settings.json is refused", !r.ok && !fs.existsSync(path.join(foreign, 'themes.json')), r.error)
  const notesBefore = read(inSync('notes.md'))
  r = await b.update({ syncFolder: syncDir })
  check(`an absolute path is accepted (${syncDir})`, r.ok, why(r))
  s = await b.settings()
  check('the folder wins over what B had', s.theme === 'custom-pulled' && s.fontSize === 22 && s.notes === notesBefore, { theme: s.theme, fontSize: s.fontSize })
  check("B's local settings are B's", s.defaultShell === shell && s.worktreesRoot === path.join(home, 'wt-b'))
  ids = (readJson(inSync('themes.json')) ?? []).map((t) => t.id)
  check("B's themes join the folder's", ids.includes('custom-mine-b') && ids.includes('custom-mine-a') && ids.includes('custom-pulled'), ids)
  check('the window paints the adopted theme', await waitFor(async () => (await b.painted()) === 'custom-pulled'))
  check("B's own preferences are backed up", readJson(path.join(userB, 'settings.before-sync.json'))?.notes === 'B notes')

  // ---- 13. turning it off keeps everything ------------------------------------------------------
  const folderBefore = syncListing().map((f) => `${f}:${read(inSync(f))}`).join('\n')
  r = await b.update({ syncFolder: '' })
  const off = readJson(path.join(userB, 'settings.json'))
  check('sync off leaves a full local settings.json', r.ok && off.syncFolder === '' && off.theme === 'custom-pulled' && off.notes === notesBefore, off && off.theme)
  check('... and the themes', (await b.themes()).some((t) => t.id === 'custom-pulled'))
  await b.update({ fontSize: 12 })
  check('later saves stay local', readJson(path.join(userB, 'settings.json')).fontSize === 12 && syncListing().map((f) => `${f}:${read(inSync(f))}`).join('\n') === folderBefore)
  check('no temp files were left behind', !syncListing().some((f) => f.endsWith('.tmp')))
  await app.close()

  log(failures ? `\n${failures} failed` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  log(`FAIL  crashed: ${e?.stack ?? e}`)
  process.exit(1)
})
