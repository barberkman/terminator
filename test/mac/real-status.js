// Does the status dot tell the truth? Each scenario puts a real `claude` into one of
// the states it gets into in daily use — a permission dialog approved fast or slow,
// denied, an Esc mid-turn, a question, plan mode, subagents, slash commands, a
// restart — and checks what `terminator list` and the sidebar dot say against what
// Claude is actually doing. It runs out/ with a throwaway app profile and your own
// Claude account; sessions are haiku at low effort (`terminator new --model
// --effort`), so a full run costs little. `flow` is the scripted loop end to end:
// ask, wait, reply, switch model and effort, ask a follow-up in the same session.
//
//   npm run build && node test/mac/real-status.js [scenario ...]
//
//   REAL_STATUS_MODE=auto   run Claude in auto permission mode (default: default,
//                           which raises the permission dialogs most scenarios need)
//   --list                  print the scenario names
//
// For each scenario it prints the status timeline (from `list`, every 250 ms) and,
// on a failure, the hook-trace lines and a screenshot. `/model` and `/effort` save
// Claude's default in ~/.claude/settings.json; the run puts those keys back.

const { _electron } = require('playwright-core')
const { execFile, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const MODE = process.env.REAL_STATUS_MODE || 'default'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'terminator-status-'))
const userData = path.join(work, 'userdata')
const proj = path.join(work, 'proj')
const shots = path.join(work, 'shots')
for (const d of [userData, proj, shots]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(proj, 'hello.txt'), 'hello\n')
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    scripting: true,
    modes: {
      normal: { command: 'claude', extraArgs: ['--permission-mode', MODE] },
      readonly: { command: 'claude', extraArgs: ['--permission-mode', 'plan'] },
    },
  }),
)
const CHEAP = ['--model', 'haiku', '--effort', 'low']
const bin = path.join(userData, 'bin', 'terminator')
const traceFile = path.join(userData, 'hook-trace.log')

let failures = 0
const results = []
function check(name, ok, detail) {
  if (!ok) failures++
  const d = detail === undefined ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d}`)
  return ok
}
const note = (s) => console.log(`NOTE  ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms, step = 250) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) {
    const v = await fn()
    if (v) return v
  }
  return fn()
}
function t(...a) {
  const r = spawnSync(bin, a, { encoding: 'utf8', cwd: proj, timeout: 600_000 })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
function listAsync() {
  return new Promise((done) =>
    execFile(bin, ['list', '--json'], { encoding: 'utf8', cwd: proj }, (_e, out) => {
      try {
        done(JSON.parse(out).sessions ?? [])
      } catch {
        done([])
      }
    }),
  )
}

// ---- Claude's own settings: /model and /effort save themselves as your default -------

const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json')
const SAVED_KEYS = ['model', 'effortLevel', 'modelSettings']
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
const before = readJson(claudeSettings)
function restoreClaudeSettings() {
  const now = readJson(claudeSettings)
  if (!before || !now) return
  let changed = false
  for (const k of SAVED_KEYS) {
    if (JSON.stringify(now[k]) === JSON.stringify(before[k])) continue
    changed = true
    if (before[k] === undefined) delete now[k]
    else now[k] = before[k]
  }
  if (changed) {
    fs.writeFileSync(claudeSettings, JSON.stringify(now, null, 2) + '\n')
    note(`put back ${SAVED_KEYS.join('/')} in ${claudeSettings}`)
  }
}

// ---- the app -------------------------------------------------------------------------

let page
const screen = (name) =>
  page.evaluate((n) => document.querySelector(`[data-pane-session="${n}"] .xterm-rows`)?.innerText ?? '', name)
/** What the sidebar row shows: the dot's status (from its colour variable) and its text. */
const row = (name) =>
  page.evaluate((n) => {
    for (const r of document.querySelectorAll('.cc-row')) {
      if (!r.textContent.includes(n)) continue
      const dot = [...r.querySelectorAll('span')].find((s) => /--c-status-/.test(s.getAttribute('style') ?? ''))
      const m = /--c-status-(\w+)/.exec(dot?.getAttribute('style') ?? '')
      return { dot: m?.[1] ?? null, text: r.innerText.replace(/\s+/g, ' ').trim() }
    }
    return { dot: null, text: '' }
  }, name)
const keys = (id, data) => page.evaluate(([i, d]) => window.terminator.writePty(i, d), [id, data])
async function showPane(name) {
  if (!(await page.$(`[data-pane-session="${name}"] .xterm`))) await page.click(`.cc-row:has-text("${name}")`)
  await page.waitForSelector(`[data-pane-session="${name}"] .xterm`, { timeout: 15_000 })
}
const words = { working: 'busy' }
const norm = (s) => (s ? words[s] ?? s : s)

/** Records a session's status every 250 ms until stopped. */
function record(id, name) {
  const tl = []
  const started = Date.now()
  let on = true
  const loop = (async () => {
    while (on) {
      const [ls, r] = await Promise.all([listAsync(), row(name).catch(() => ({ dot: null, text: '' }))])
      const s = ls.find((x) => x.id === id)
      tl.push({ t: Date.now() - started, list: norm(s?.status), dot: r.dot, text: r.text })
      await sleep(250)
    }
  })()
  const rec = {
    tl,
    started,
    now: () => tl.at(-1)?.list,
    async stop() {
      on = false
      await loop
    },
    /** Statuses in order, repeats folded: "idle → busy → waiting → idle". */
    summary() {
      const out = []
      for (const p of tl) {
        const w = `${p.list}${p.dot && p.dot !== p.list ? `[dot ${p.dot}]` : ''}`
        if (out.at(-1)?.w !== w) out.push({ w, t: p.t })
      }
      return out.map((x) => `${x.w}@${(x.t / 1000).toFixed(1)}s`).join(' → ')
    },
    seen: (st) => tl.some((p) => p.list === st),
    /** Until the recorded status is `st`. */
    until: (st, ms) => waitFor(() => rec.now() === st, ms),
    /** Until the recorded status is anything but `st`. */
    leaves: (st, ms) => waitFor(() => rec.now() && rec.now() !== st, ms),
    /** Whether it stayed `st` for `ms` (checked from now on). */
    async holds(st, ms) {
      const from = tl.length
      await sleep(ms)
      return tl.slice(from).every((p) => p.list === st)
    },
    /** Whether the dot ever disagreed with `list` for more than a moment. */
    dotLag() {
      let run = 0
      let worst = 0
      for (const p of tl) {
        run = p.dot && p.list && p.dot !== p.list ? run + 1 : 0
        worst = Math.max(worst, run)
      }
      return worst * 250
    },
  }
  return rec
}

function traceFor(id, since) {
  if (!fs.existsSync(traceFile)) return []
  const s = id.slice(0, 8)
  return fs
    .readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.s === s && l.t >= since)
}
const fmtTrace = (lines, since) =>
  lines
    .map(
      (l) =>
        `    +${((l.t - since) / 1000).toFixed(2)}s ${l.ev}${l.nt ? `(${l.nt})` : ''}${l.tool ? ` ${l.tool}` : ''} p=${l.p ?? '-'} ${l.d} ${l.from}→${l.to}${l.at ? ` stamp${l.at - l.t >= 0 ? '+' : ''}${l.at - l.t}ms` : ''}`,
    )
    .join('\n')

// ---- sessions ------------------------------------------------------------------------

let trusted = false
/** A new Claude session in its own pane, its input box up. */
async function claude(name, flags = CHEAP) {
  const r = t('new', 'claude', '--project', proj, '--name', name, ...flags)
  if (r.code !== 0) throw new Error(`new ${name}: ${r.err}`)
  const id = r.out
  await showPane(name)
  // A folder Claude hasn't seen asks to be trusted first, and for a temp folder the
  // dialog's default is "No, exit" — so it's answered only once its Yes is drawn,
  // and every time it shows, not just the first.
  const trustUp = () => waitFor(async () => /Yes, I trust this folder/.test(await screen(name)), trusted ? 4000 : 30_000)
  if (await trustUp()) await trustYes(name, id)
  trusted = true
  // SessionStart: the status reads idle/ready once Claude's hooks have reported in.
  await waitFor(async () => /ready/.test((await row(name)).text), 60_000)
  await sleep(1500)
  return id
}
/** `terminator send`, without stopping the recorders while it waits for Claude. */
/**
 * Answer Claude's trust question with Yes. The dialog is drawn a moment before it
 * listens, so the arrow goes again until Yes is the one marked — and Enter only
 * then, never on "No, exit".
 */
async function trustYes(name, id) {
  const onYes = async () => /❯\s*\d?\.?\s*Yes, I trust/.test(await screen(name))
  for (let i = 0; i < 20 && !(await onYes()); i++) {
    await keys(id, i % 2 ? '\x1bOB' : '\x1b[B')
    await waitFor(onYes, 700)
  }
  if (!(await onYes())) throw new Error(`couldn't move ${name}'s trust dialog to Yes`)
  await keys(id, '\r')
}
/** The session as `list --json` has it. */
const listed = (id) => (JSON.parse(t('list', '--json').out || '{}').sessions ?? []).find((s) => s.id === id)
/** The model of each answer in a session's transcript, oldest first. */
function answerModels(id) {
  const sessions = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'))
  const conv = sessions.find((s) => s.id === id)?.conversationId ?? id
  const root = path.join(os.homedir(), '.claude', 'projects')
  const dir = fs.readdirSync(root).find((d) => d.endsWith(path.basename(work) + '-proj'))
  const file = dir && path.join(root, dir, `${conv}.jsonl`)
  if (!file || !fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === 'assistant' && r.message?.model && r.message.model !== '<synthetic>')
    .map((r) => r.message.model)
}
function send(id, text) {
  return new Promise((done, fail) =>
    execFile(bin, ['send', id, text], { encoding: 'utf8', cwd: proj }, (e, _out, err) =>
      e ? fail(new Error(`send: ${err || e.message}`)) : done(),
    ),
  )
}
/** The number in front of a dialog's option that matches `re`, from the screen. */
async function optionNumber(name, re) {
  const lines = (await screen(name)).split('\n')
  for (const l of lines) {
    const m = /(\d)\.\s+(.*)/.exec(l)
    if (m && re.test(m[2])) return m[1]
  }
  return null
}
/** Enter on whatever dialog is up, until the session leaves waiting for good. */
async function approveAll(rec, id, ms = 120_000) {
  await rec.leaves('idle', 60_000)
  const end = Date.now() + ms
  while (Date.now() < end) {
    const st = await waitFor(() => (['waiting', 'idle', 'error'].includes(rec.now()) ? rec.now() : null), end - Date.now())
    if (st !== 'waiting') return st
    await sleep(800)
    await keys(id, '\r')
    await waitFor(() => rec.now() !== 'waiting', 15_000)
  }
  return rec.now()
}

// ---- scenarios -------------------------------------------------------------------------

const BASH = (cmd, then = 'Then reply with only the word done.') =>
  `Use the Bash tool to run exactly this command: ${cmd} — ${then} Do not use any other tool.`
/** A command that runs `s` seconds and asks permission first — a bare `sleep` does neither. */
const LONG = (s) => `node -e "setTimeout(() => require('fs').writeFileSync('slept-${s}.txt', 'x'), ${s * 1000})"`

const scenarios = {
  async plain(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(id, 'Reply with exactly the word pong and nothing else.')
    await rec.leaves('idle', 60_000)
    const end = await rec.until('idle', 120_000)
    await rec.stop()
    return { id, rec, checks: [['a plain turn ends idle', end && rec.seen('busy'), rec.summary()]] }
  },

  async 'approve-fast'(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(id, BASH('touch approved-fast.txt'))
    const dialog = await rec.until('waiting', 90_000)
    await sleep(500)
    await keys(id, '\r')
    const end = await rec.until('idle', 90_000)
    const held = end && (await rec.holds('idle', 12_000))
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['the permission dialog reads waiting', dialog, rec.summary()],
        ['approved quickly, it ends idle', end, rec.summary()],
        ['... and stays idle (no late permission notice)', held, rec.summary()],
      ],
    }
  },

  async 'approve-slow'(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(id, BASH('touch approved-slow.txt'))
    const dialog = await rec.until('waiting', 90_000)
    await sleep(9_000) // past the ~6 s permission_prompt notification
    const stillWaiting = rec.now() === 'waiting'
    await keys(id, '\r')
    const end = await rec.until('idle', 90_000)
    const held = end && (await rec.holds('idle', 12_000))
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['the permission dialog reads waiting', dialog, rec.summary()],
        ['... and keeps reading waiting while it is up', stillWaiting, rec.summary()],
        ['approved after 9 s, it ends idle', end, rec.summary()],
        ['... and stays idle', held, rec.summary()],
      ],
    }
  },

  async 'deny-esc'(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(id, BASH('touch denied-esc.txt'))
    const dialog = await rec.until('waiting', 90_000)
    await sleep(1000)
    await keys(id, '\x1b')
    const end = await rec.until('idle', 20_000)
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['the permission dialog reads waiting', dialog, rec.summary()],
        ['denied with Esc, it reads idle', end, rec.summary()],
      ],
    }
  },

  async 'deny-no'(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(id, BASH('touch denied-no.txt'))
    const dialog = await rec.until('waiting', 90_000)
    await sleep(1000)
    const no = await optionNumber(n, /^No/)
    if (no) await keys(id, no)
    await sleep(300)
    if (/\d\.\s+No/.test(await screen(n))) await keys(id, '\r') // a list that moves, not picks, on a digit
    const end = await rec.until('idle', 20_000)
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['the permission dialog reads waiting', dialog, rec.summary()],
        ['the dialog has a No option', !!no, (await screen(n)).slice(-600)],
        ['denied with No, it reads idle', end, rec.summary()],
      ],
    }
  },

  async 'esc-tool'(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(id, BASH(LONG(40)))
    if (await rec.until('waiting', 60_000)) {
      await sleep(500)
      await keys(id, '\r')
    }
    const running = await waitFor(() => rec.now() === 'busy', 20_000)
    await sleep(4000)
    await keys(id, '\x1b')
    const end = await rec.until('idle', 20_000)
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['the command is running', running, rec.summary()],
        ['Esc mid-command: it reads idle', end, rec.summary()],
      ],
    }
  },

  async 'esc-text'(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(id, 'Write a 1500-word story about a lighthouse keeper. Do not use any tools.')
    const busy = await rec.until('busy', 30_000)
    await sleep(3000)
    await keys(id, '\x1b')
    const end = await rec.until('idle', 20_000)
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['the turn is running', busy, rec.summary()],
        ['Esc while it writes: it reads idle', end, rec.summary()],
      ],
    }
  },

  async 'long-tool'(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(id, BASH(LONG(15)))
    const dialog = await rec.until('waiting', 60_000)
    await sleep(500)
    await keys(id, '\r')
    await sleep(5000) // the command is running now
    const during = rec.now()
    const end = await rec.until('idle', 90_000)
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['the permission dialog reads waiting', dialog, rec.summary()],
        ['once approved, the running command reads working, not waiting', during === 'busy', `${during}: ${rec.summary()}`],
        ['it ends idle', end, rec.summary()],
      ],
    }
  },

  async ask(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(
      id,
      'Use the AskUserQuestion tool to ask me one question: which colour I prefer, with exactly two options, Red and Blue. Then reply with only my answer.',
    )
    const dialog = await rec.until('waiting', 90_000)
    const asking = await waitFor(async () => /Which colou?r/i.test(await screen(n)), 10_000)
    await sleep(2000)
    const whileAsking = rec.now()
    await keys(id, '\r')
    // A question form may want its answers submitted too.
    await sleep(1500)
    if (/submit/i.test(await screen(n)) && rec.now() !== 'idle') await keys(id, '\r')
    const end = await rec.until('idle', 90_000)
    const reply = t('reply', id).out
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['the question reads waiting', dialog, rec.summary()],
        ['the question is on screen', !!asking, (await screen(n)).slice(-600)],
        ['while Claude asks, it reads waiting', whileAsking === 'waiting', `${whileAsking}: ${rec.summary()}`],
        ['answered, it ends idle', end, rec.summary()],
        ['... with the first option as the answer', /red/i.test(reply), reply],
      ],
    }
  },

  async plan(n) {
    const id = await claude(n)
    await page.evaluate((i) => window.terminator.setMode(i, 'readonly'), id)
    await waitFor(async () => /ready/.test((await row(n)).text), 60_000)
    await sleep(2000)
    const rec = record(id, n)
    await send(id, 'Make a one-step plan to create a file named plan.txt containing hi, and present it for approval with ExitPlanMode right away.')
    const dialog = await rec.until('waiting', 120_000)
    const end = await approveAll(rec, id, 180_000)
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['the plan approval reads waiting', dialog, rec.summary()],
        ['approved, it ends idle', end === 'idle', rec.summary()],
      ],
    }
  },

  async subagent(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(
      id,
      'Use the Agent tool (Task) to launch exactly one general-purpose subagent whose only job is to reply with the word hi. After it returns, reply with only the word done.',
    )
    const end = await approveAll(rec, id, 180_000)
    await rec.stop()
    // Idle only at the end: a subagent finishing mustn't read as the turn finishing.
    const firstIdle = rec.tl.findIndex((p, i) => i > 0 && p.list === 'idle' && rec.tl[i - 1].list !== 'idle')
    const lastBusy = rec.tl.map((p) => p.list).lastIndexOf('busy')
    return {
      id,
      rec,
      checks: [
        ['a subagent turn ends idle', end === 'idle', rec.summary()],
        ['... and reads idle only once it is over', firstIdle < 0 || firstIdle > lastBusy, rec.summary()],
      ],
    }
  },

  async background(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(
      id,
      'Use the Bash tool with run_in_background set to true to run exactly: sleep 10; echo bg-done — do not wait for it, and reply with only the word started.',
    )
    const end = await approveAll(rec, id, 120_000)
    // The command finishes ~10 s later; Claude may take a turn to look at it.
    await sleep(20_000)
    const settled = await rec.until('idle', 90_000)
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['the turn ends idle', end === 'idle', rec.summary()],
        ['after the background command finishes, it reads idle', settled, rec.summary()],
      ],
    }
  },

  async slash(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(id, 'Reply with exactly the word pong and nothing else.')
    await rec.leaves('idle', 60_000)
    await rec.until('idle', 120_000)
    for (const cmd of ['/model haiku', '/effort low']) {
      await keys(id, cmd)
      await sleep(400)
      await keys(id, '\r')
      await sleep(3000)
    }
    const held = await rec.holds('idle', 3000)
    await send(id, '/compact')
    const compacting = await rec.leaves('idle', 30_000)
    const compacted = await rec.until('idle', 120_000)
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['/model and /effort leave it idle', held && !rec.seen('waiting'), rec.summary()],
        ['/compact reads working', compacting, rec.summary()],
        ['/compact ends idle', compacted, rec.summary()],
      ],
    }
  },

  async clear(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(id, 'Reply with exactly the word alpha and nothing else.')
    await rec.leaves('idle', 60_000)
    await rec.until('idle', 120_000)
    await keys(id, '/clear')
    await sleep(400)
    await keys(id, '\r')
    await sleep(4000)
    // Claude is on a new conversation now, under a session_id of its own.
    await send(id, 'Reply with exactly the word bravo and nothing else.')
    const working = await rec.leaves('idle', 60_000)
    const end = await rec.until('idle', 120_000)
    const reply = t('reply', id)
    const sessions = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'))
    const conv = sessions.find((s) => s.id === id)?.conversationId
    // A relaunch picks the new conversation back up.
    t('stop', id)
    await page.evaluate((i) => window.terminator.startSession(i, 120, 40), id)
    await waitFor(async () => /ready/.test((await row(n)).text), 60_000)
    await sleep(1500)
    await send(id, 'What was the one word you replied with last? Reply with only that word.')
    await rec.leaves('idle', 60_000)
    await rec.until('idle', 120_000)
    const after = t('reply', id)
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['after /clear, a prompt reads working', working, rec.summary()],
        ['... and ends idle', end, rec.summary()],
        ['reply reads the conversation /clear started', /bravo/i.test(reply.out), reply],
        ['the session knows the new conversation', !!conv && conv !== id, conv],
        ['a relaunch resumes the new conversation', /bravo/i.test(after.out), after],
      ],
    }
  },

  async trust(n) {
    // A folder Claude has never seen: its trust question comes before any hook.
    const fresh = path.join(work, `fresh-${Date.now()}`)
    fs.mkdirSync(fresh, { recursive: true })
    const id = t('new', 'claude', '--project', fresh, '--name', n, ...CHEAP).out
    await showPane(n)
    const rec = record(id, n)
    const asked = await waitFor(async () => /Yes, I trust this folder/.test(await screen(n)), 30_000)
    const reads = await rec.until('waiting', 5000)
    const r0 = await row(n)
    // A send straight away holds until it's answered.
    let sent = false
    const sending = send(id, 'Reply with exactly the word pong and nothing else.').then(() => (sent = true))
    await sleep(2000)
    const held = !sent && rec.now() === 'waiting'
    await trustYes(n, id)
    await sending
    await rec.leaves('idle', 60_000)
    const end = await rec.until('idle', 120_000)
    const reply = t('reply', id).out
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['Claude asks whether to trust the folder', !!asked, (await screen(n)).slice(-400)],
        ['... and it reads waiting, with the needs-me dot', reads && r0.dot === 'waiting' && /trust this folder\?/.test(r0.text), { summary: rec.summary(), row: r0 }],
        ['a send holds while it is up', held, rec.summary()],
        ['answered Yes, the prompt goes in and the turn ends idle', end && /pong/i.test(reply), { summary: rec.summary(), reply }],
      ],
    }
  },

  async 'idle-nudge'(n) {
    const id = await claude(n)
    const rec = record(id, n)
    await send(id, 'Reply with exactly the word pong and nothing else.')
    await rec.leaves('idle', 60_000)
    await rec.until('idle', 120_000)
    const held = await rec.holds('idle', 75_000) // Claude's idle_prompt comes ~60 s in
    await rec.stop()
    const nudged = traceFor(id, rec.started).some((l) => l.nt === 'idle_prompt')
    if (!nudged) note('no idle_prompt arrived in 75 s')
    return { id, rec, checks: [['idle for 75 s, it stays idle', held, rec.summary()]] }
  },

  async flow(n) {
    const id = await claude(n)
    const rec = record(id, n)
    const start = listed(id)
    await send(id, 'Pick one fruit at random and reply with only its name, in lowercase.')
    let w = t('wait', id, 'idle', 'error', '--timeout', '3m')
    const fruit = t('reply', id).out
    const m = t('model', id, 'sonnet')
    const e = t('effort', id, 'high')
    const switched = listed(id)
    await send(id, `You said "${fruit}". Reply with only the usual colour of that fruit, in lowercase.`)
    const w2 = t('wait', id, 'idle', 'error', '--timeout', '3m')
    const colour = t('reply', id).out
    const models = answerModels(id)
    const after = listed(id) // the statusLine has run again after that turn
    // Mid-turn, a switch is refused rather than queued behind the turn.
    await send(id, BASH(LONG(6)))
    await rec.leaves('idle', 60_000)
    const busy = t('model', id, 'haiku')
    await approveAll(rec, id, 120_000)
    // Values Claude or the command won't take.
    const badEffort = t('effort', id, 'extreme')
    const badModel = t('model', id, 'no-such-model-xyz')
    await sleep(1500)
    const screenAfterBad = await screen(n)
    const idleAfterBad = rec.now()
    // A Stop and Start keeps the last choice.
    t('stop', id)
    await page.evaluate((i) => window.terminator.startSession(i, 120, 40), id)
    await waitFor(async () => /ready/.test((await row(n)).text), 60_000)
    await sleep(1500)
    await send(id, 'Reply with exactly the word ok and nothing else.')
    const w3 = t('wait', id, 'idle', 'error', '--timeout', '3m')
    const relaunched = listed(id)
    const lastModel = answerModels(id).at(-1)
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['new --model haiku --effort low: list says so', /haiku/i.test(start?.model ?? '') && start?.effort === 'low', start],
        ['ask → wait → reply', w.out === 'idle' && /^[a-z]+$/.test(fruit), { w, fruit }],
        ['model sonnet', m.code === 0 && /^Set model to `Sonnet/.test(m.out), m],
        ['effort high', e.code === 0 && /^Set effort level to high/.test(e.out), e],
        ['list shows the switch at once', /sonnet/i.test(switched?.model ?? '') && switched?.effort === 'high', switched],
        ['a follow-up in the same session, built from the reply', w2.out === 'idle' && /^[a-z]+\.?$/.test(colour), { w2, colour }],
        ['the follow-up was answered by sonnet, the first by haiku', /haiku/.test(models[0] ?? '') && /sonnet/.test(models.at(-1) ?? ''), models],
        ["after the turn, Claude's own report agrees", /sonnet/i.test(after?.model ?? '') && after?.effort === 'high', after],
        ['a switch while it works is refused', busy.code === 1 && /wait for idle/.test(busy.err), busy],
        ['an effort Claude has no such level of is refused', badEffort.code === 1 && /effort is one of/.test(badEffort.err), badEffort],
        ["a model Claude doesn't know fails with Claude's word for it", badModel.code === 1 && badModel.err.length > 0, badModel],
        ['... and leaves the session idle at its prompt', idleAfterBad === 'idle', `${idleAfterBad}: ${screenAfterBad.slice(-400)}`],
        ['Stop and Start keep sonnet/high', w3.out === 'idle' && /sonnet/.test(lastModel ?? '') && relaunched?.effort === 'high', { w3, lastModel, relaunched }],
      ],
    }
  },

  async lifecycle(n) {
    const id = await claude(n)
    const rec = record(id, n)
    let r = t('stop', id)
    const closed = r.code === 0 && (await rec.until('closed', 15_000))
    await page.evaluate((i) => window.terminator.startSession(i, 120, 40), id)
    const ready = await waitFor(async () => rec.now() === 'idle' && /ready/.test((await row(n)).text), 60_000)
    await sleep(1500)
    await keys(id, '/exit')
    await sleep(400)
    await keys(id, '\r')
    const exited = await rec.until('closed', 20_000)
    await rec.stop()
    return {
      id,
      rec,
      checks: [
        ['stop: closed', closed, rec.summary()],
        ['start: idle and ready', ready, rec.summary()],
        ['/exit: closed', exited, rec.summary()],
      ],
    }
  },

  async twins(n) {
    const a = await claude(`${n}-a`)
    const b = await claude(`${n}-b`)
    const ra = record(a, `${n}-a`)
    const rb = record(b, `${n}-b`)
    await send(a, BASH('sleep 6', 'Then reply with only the word done.'))
    const end = await approveAll(ra, a, 120_000)
    await ra.stop()
    await rb.stop()
    return {
      id: a,
      rec: ra,
      checks: [
        ['A works and ends idle', end === 'idle' && ra.seen('busy'), ra.summary()],
        ['B, in the same folder, stays idle throughout', rb.tl.every((p) => p.list === 'idle'), rb.summary()],
      ],
    }
  },
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    console.log(Object.keys(scenarios).join('\n'))
    return
  }
  const pick = args.length ? args : Object.keys(scenarios)
  for (const s of pick) if (!scenarios[s]) throw new Error(`no scenario ${s}; --list names them`)
  console.log(`real-status — permission mode ${MODE}, work folder ${work}`)
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [REPO, `--user-data-dir=${userData}`],
    env: process.env,
    cwd: work,
  })
  try {
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    check('control.json written', !!(await waitFor(() => fs.existsSync(path.join(userData, 'control.json')), 30_000)))
    for (const name of pick) {
      console.log(`\n== ${name}`)
      const since = Date.now()
      let res
      try {
        res = await scenarios[name](name)
      } catch (e) {
        check(`${name} ran`, false, String(e?.stack ?? e))
        await page.screenshot({ path: path.join(shots, `${name}.png`) }).catch(() => {})
        continue
      }
      let ok = true
      for (const [label, pass, detail] of res.checks) ok = check(label, !!pass, detail) && ok
      const lag = res.rec.dotLag()
      ok = check('the sidebar dot agrees with list', lag <= 1000, `longest disagreement ${lag} ms`) && ok
      console.log(`  timeline: ${res.rec.summary()}`)
      if (!ok) {
        console.log(`  trace:\n${fmtTrace(traceFor(res.id, since), since)}`)
        await page.screenshot({ path: path.join(shots, `${name}.png`) }).catch(() => {})
        console.log(`  screenshot: ${path.join(shots, `${name}.png`)}`)
      }
      results.push({ name, ok, timeline: res.rec.summary() })
      t('stop', res.id)
    }
  } finally {
    await app.close().catch(() => {})
    restoreClaudeSettings()
  }
  console.log('\nsummary')
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`)
  console.log(failures ? `\n${failures} FAILED (work folder ${work})` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  restoreClaudeSettings()
  process.exit(1)
})
