#!/usr/bin/env node
// A stand-in for `claude`, for the scripting end-to-end test (e2e.js). It does the
// three things Terminator reads from a real one: fires the hooks in the --settings
// file it is started with, writes the transcript where Claude would, and behaves like
// an input box — a bracketed paste, then Enter, submits.
//
// Its prompts steer it, so the test can reach the cases a real Claude gets into:
//   • typed before SessionStart  — dropped, as a TUI that hasn't drawn its box loses it
//   • containing ASK             — raises a permission request, waits for any line typed
//   • containing NOHOOK          — its UserPromptSubmit report never reaches the app
//   • starting with /            — a slash command: no turn, no hook, no transcript
//
// Every turn runs a "tool" (PreToolUse) and answers in markdown with an em dash, so a
// reply exercises more than ASCII. FAKE_CLAUDE_STARTUP_MS and FAKE_CLAUDE_TURN_MS
// set how long it takes to come up and to answer.
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execSync } = require('child_process')

const argv = process.argv.slice(2)
const at = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const id = at('--session-id') || at('--resume')
const settings = JSON.parse(fs.readFileSync(at('--settings'), 'utf8'))
const cwd = process.cwd()
const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, id + '.jsonl')
const log = (s) => fs.appendFileSync(path.join(os.homedir(), 'fake-claude.log'), `${new Date().toISOString()} ${id.slice(0, 8)} ${s}\n`)
// How it was started and what it inherited, for the tests that check the launch itself.
const pick = (...names) => Object.fromEntries(names.map((n) => [n, process.env[n] ?? null]))
log(
  `start ${JSON.stringify({
    resume: argv.includes('--resume'),
    cwd,
    env: pick('PATH', 'LANG', 'TERM_PROGRAM', 'ELECTRON_RUN_AS_NODE', 'VISUAL', 'FROM_ZPROFILE', 'FROM_ZSHRC'),
  })}`,
)

function fire(event, extra) {
  for (const g of settings.hooks[event] || []) {
    for (const h of g.hooks || []) {
      try {
        execSync(h.command, {
          input: JSON.stringify({ session_id: id, hook_event_name: event, cwd, ...extra }),
          stdio: ['pipe', 'ignore', 'ignore'],
        })
      } catch {}
    }
  }
}
function record(rec) {
  fs.appendFileSync(
    file,
    JSON.stringify({ sessionId: id, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), ...rec }) + '\n',
  )
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ready = false
let busy = false
let answer = null
let buf = ''
let pasting = false
let input = ''
const queue = []

process.stdout.write('fake claude starting...\r\n')
setTimeout(() => {
  fire('SessionStart', { source: 'startup' })
  ready = true
  log('ready')
  process.stdout.write('> ')
}, Number(process.env.FAKE_CLAUDE_STARTUP_MS || 1500))

async function submit(text) {
  if (!ready) {
    log(`DROPPED before ready: ${text}`)
    process.stdout.write('[dropped: not ready]\r\n')
    return
  }
  if (busy) {
    queue.push(text)
    return
  }
  // A slash command: handled locally, never a turn, no hook, nothing in the transcript.
  if (text.startsWith('/')) {
    log(`slash: ${text}`)
    process.stdout.write(`\r\n(ran ${text})\r\n> `)
    return
  }
  busy = true
  const pid = crypto.randomUUID()
  log(`submit: ${text}`)
  // NOHOOK: the UserPromptSubmit report is lost on its way to the app.
  if (!text.includes('NOHOOK')) fire('UserPromptSubmit', { prompt: text, prompt_id: pid })
  record({ type: 'user', message: { role: 'user', content: text } })
  process.stdout.write(`\r\n> ${text}\r\n`)
  // Like a real turn, it runs a tool — which moves the status even when the submit report was lost.
  await sleep(200)
  fire('PreToolUse', { tool_name: 'Bash', prompt_id: pid })
  await sleep(Number(process.env.FAKE_CLAUDE_TURN_MS || 1500))
  if (text.includes('ASK')) {
    fire('PermissionRequest', { tool_name: 'Bash', prompt_id: pid })
    process.stdout.write('Allow Bash? (type anything)\r\n')
    await new Promise((r) => (answer = r))
  }
  const reply = `Reply to: ${text}\n\n- one — two\n- three`
  record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } })
  fire('Stop', { prompt_id: pid })
  busy = false
  process.stdout.write(reply.replace(/\n/g, '\r\n') + '\r\n> ')
  if (queue.length) void submit(queue.shift())
}

process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  for (;;) {
    if (pasting) {
      const end = buf.indexOf('\x1b[201~')
      if (end < 0) {
        input += buf
        buf = ''
        return
      }
      input += buf.slice(0, end)
      buf = buf.slice(end + 6)
      pasting = false
      continue
    }
    if (buf === '\x03') process.exit(0)
    const start = buf.indexOf('\x1b[200~')
    const cr = buf.indexOf('\r')
    if (start >= 0 && (cr < 0 || start < cr)) {
      input += buf.slice(0, start)
      buf = buf.slice(start + 6)
      pasting = true
      continue
    }
    if (cr >= 0) {
      input += buf.slice(0, cr)
      buf = buf.slice(cr + 1)
      const text = input
      input = ''
      if (answer) {
        const r = answer
        answer = null
        r()
      } else if (text.trim()) void submit(text)
      continue
    }
    input += buf
    buf = ''
    return
  }
})
