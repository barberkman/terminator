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
//   • containing SLOW            — the turn takes 8 seconds, long enough to Esc out of
//   • containing ASK and SLOWTOOL — once the dialog is answered, the tool runs 4 seconds
//   • REPLAY <name>              — plays a hook sequence from hook-scenarios.js
//   • /model <m>, /effort <l>    — answered in the transcript the way Claude answers them;
//                                  mid-conversation, /model asks "Switch model?" first
//   • /compact                   — PreCompact, then PostCompact: no turn, no Stop
//   • /clear                     — a new conversation under a new session_id, as Claude does
//   • any other /…               — a slash command: no turn, no hook, no transcript
//
// Esc while a turn runs (or a dialog is up) interrupts it as Claude does: a
// "[Request interrupted by user]" record, and no hook at all — or, for a prompt
// containing QUIET, no record either, as when Claude hadn't answered anything yet.
//
// Every turn runs a "tool" (PreToolUse) and answers in markdown with an em dash, so a
// reply exercises more than ASCII. FAKE_CLAUDE_STARTUP_MS and FAKE_CLAUDE_TURN_MS
// set how long it takes to come up and to answer.
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execSync, spawn } = require('child_process')

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
// The conversation it is on: /clear moves it to a new one, under a new id.
let sid = id
let file = path.join(dir, sid + '.jsonl')
let model = at('--model') || 'default'
let effort = at('--effort') || 'medium'
const display = (m) => `Fake ${m[0].toUpperCase()}${m.slice(1)}`
const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
let answered = 0
const log = (s) => fs.appendFileSync(path.join(os.homedir(), 'fake-claude.log'), `${new Date().toISOString()} ${id.slice(0, 8)} ${s}\n`)
// How it was started and what it inherited, for the tests that check the launch itself.
const pick = (...names) => Object.fromEntries(names.map((n) => [n, process.env[n] ?? null]))
log(
  `start ${JSON.stringify({
    resume: argv.includes('--resume'),
    as: sid,
    model: at('--model') ?? null,
    effort: at('--effort') ?? null,
    cwd,
    env: pick('PATH', 'LANG', 'TERM_PROGRAM', 'ELECTRON_RUN_AS_NODE', 'VISUAL', 'FROM_ZPROFILE', 'FROM_ZSHRC'),
  })}`,
)

function fire(event, extra) {
  for (const g of settings.hooks[event] || []) {
    for (const h of g.hooks || []) {
      try {
        execSync(h.command, {
          input: JSON.stringify({ session_id: sid, hook_event_name: event, cwd, ...extra }),
          stdio: ['pipe', 'ignore', 'ignore'],
        })
      } catch {}
    }
  }
}
/**
 * One hook, in the background and stamped `stamp` — as if Claude had emitted it then.
 * The stamp is the reporter's last argument (reporter-source.ts), the one WSL passes.
 */
function fireLater(event, extra, stamp) {
  for (const g of settings.hooks[event] || []) {
    for (const h of g.hooks || []) {
      const c = spawn(`${h.command} ${stamp}`, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] })
      c.stdin.end(JSON.stringify({ session_id: sid, hook_event_name: event, cwd, ...extra }))
    }
  }
}
/** What Claude's statusLine reports: its model and effort, as the pane header shows them. */
function status() {
  try {
    execSync(settings.statusLine.command, {
      input: JSON.stringify({ session_id: sid, model: { id: model, display_name: display(model) }, effort: { level: effort } }),
      stdio: ['pipe', 'ignore', 'ignore'],
    })
  } catch {}
}
function record(rec) {
  fs.appendFileSync(
    file,
    JSON.stringify({ sessionId: sid, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), ...rec }) + '\n',
  )
}
/** A slash command as Claude writes it down: the command, then what it printed. */
function recordCommand(name, args, out) {
  const user = (content) => record({ type: 'user', message: { role: 'user', content } })
  user(`<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`)
  user(`<local-command-stdout>${out}</local-command-stdout>`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** The turn in progress, if any, and how to cut its waits short when it's interrupted. */
let turn = null
const pause = (ms) =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    if (turn) turn.wake = () => (clearTimeout(t), r())
  })

let ready = false
let busy = false
let answer = null
let buf = ''
let pasting = false
let input = ''
const queue = []

process.stdout.write('fake claude starting...\r\n')
setTimeout(() => {
  fire('SessionStart', { source: argv.includes('--resume') ? 'resume' : 'startup' })
  status()
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
  const [cmd, arg = ''] = text.trim().split(/\s+/)
  if (cmd === '/model' || cmd === '/effort') {
    log(`slash: ${text}`)
    if (cmd === '/model' && !MODELS.includes(arg)) {
      // Claude writes a command that failed down as a system record, not as yours.
      const err = (content) => record({ type: 'system', subtype: 'local_command', level: 'info', content })
      err(`<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>${arg}</command-args>`)
      err(`<local-command-stdout>Model '${arg}' not found</local-command-stdout>`)
      process.stdout.write(`\r\nModel '${arg}' not found\r\n> `)
      return
    }
    if (cmd === '/model' && answered > 0 && arg !== model) {
      // A conversation is cached for its model, so Claude asks first.
      busy = true
      process.stdout.write(
        `\r\n\x1b[1mSwitch model?\x1b[0m\r\n  \x1b[36m❯\x1b[0m 1. Yes, switch to ${display(arg)}\r\n    2. No, go back\r\n`,
      )
      log('asking to switch')
      await new Promise((r) => (answer = r))
      busy = false
    }
    let out
    if (cmd === '/model') {
      model = arg
      out = `Set model to \`${display(arg)}\` and saved as your default for new sessions`
    } else if (['low', 'medium', 'high', 'xhigh', 'max'].includes(arg)) {
      effort = arg
      out = `Set effort level to ${arg} (saved as your default for new sessions)`
    } else out = `Invalid effort level: ${arg}`
    recordCommand(cmd.slice(1), arg, out)
    process.stdout.write(`\r\n${out}\r\n> `)
    if (queue.length) void submit(queue.shift())
    return
  }
  if (cmd === '/compact') {
    log(`slash: ${text}`)
    const pid = crypto.randomUUID()
    fire('PreCompact', { trigger: 'manual', prompt_id: pid })
    await sleep(800)
    fire('SessionStart', { source: 'compact', prompt_id: pid })
    fire('PostCompact', { trigger: 'manual', prompt_id: pid })
    recordCommand('compact', '', 'Compacted')
    process.stdout.write('\r\n(compacted)\r\n> ')
    return
  }
  if (cmd === '/clear') {
    // Claude ends the conversation and starts another, with its own id and transcript.
    log(`slash: ${text}`)
    fire('SessionEnd', { reason: 'clear' })
    sid = crypto.randomUUID()
    file = path.join(dir, sid + '.jsonl')
    fire('SessionStart', { source: 'clear' })
    recordCommand('clear', '', '')
    log(`cleared: now ${sid}`)
    process.stdout.write('\r\n(cleared)\r\n> ')
    return
  }
  // A slash command: handled locally, never a turn, no hook, nothing in the transcript.
  if (text.startsWith('/')) {
    log(`slash: ${text}`)
    process.stdout.write(`\r\n(ran ${text})\r\n> `)
    return
  }
  if (text.startsWith('REPLAY ')) return replay(text.slice(7).trim(), text)
  busy = true
  const pid = crypto.randomUUID()
  turn = { interrupted: false, wake: null, text }
  const me = turn
  log(`submit: ${text}`)
  // NOHOOK: the UserPromptSubmit report is lost on its way to the app.
  if (!text.includes('NOHOOK')) fire('UserPromptSubmit', { prompt: text, prompt_id: pid })
  // PASTED: recorded the way claude 2.1.310 records a pasted prompt.
  const recorded = text.includes('PASTED') ? `\n\n<pasted_content id="2ef3">\n${text}\n</pasted_content id="2ef3">\n` : text
  record({ type: 'user', message: { role: 'user', content: recorded } })
  process.stdout.write(`\r\n> ${text}\r\n`)
  // Like a real turn, it runs a tool — which moves the status even when the submit report was lost.
  await sleep(200)
  fire('PreToolUse', { tool_name: 'Bash', prompt_id: pid })
  await pause(text.includes('SLOW') ? 8000 : Number(process.env.FAKE_CLAUDE_TURN_MS || 1500))
  if (!me.interrupted && text.includes('ASK')) {
    fire('PermissionRequest', { tool_name: 'Bash', prompt_id: pid })
    process.stdout.write('Allow Bash? (type anything)\r\n')
    await new Promise((r) => {
      answer = r
      me.wake = r
    })
  }
  if (!me.interrupted && text.includes('ASK') && text.includes('SLOWTOOL')) await pause(4000)
  if (me.interrupted) return endTurn()
  answered++
  const reply = `Reply to: ${text}\n\n- one — two\n- three`
  record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } })
  fire('Stop', { prompt_id: pid })
  status()
  process.stdout.write(reply.replace(/\n/g, '\r\n'))
  endTurn()
}

function endTurn() {
  turn = null
  busy = false
  process.stdout.write('\r\n> ')
  if (queue.length) void submit(queue.shift())
}

/** Esc mid-turn: Claude writes the interrupt down, and fires no hook for it. */
function interrupt() {
  if (!turn || turn.interrupted) return
  turn.interrupted = true
  answer = null
  if (!turn.text.includes('QUIET')) {
    record({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
  }
  log('interrupted')
  process.stdout.write('\r\nInterrupted · What should Claude do instead?')
  turn.wake?.()
}

/** A hook sequence from hook-scenarios.js, each hook stamped and delivered when the scenario says. */
async function replay(name, text) {
  const scenario = require('./hook-scenarios')[name]
  if (!scenario) {
    log(`no replay ${name}`)
    return
  }
  busy = true
  const pid = crypto.randomUUID()
  fire('UserPromptSubmit', { prompt: text, prompt_id: pid })
  record({ type: 'user', message: { role: 'user', content: text } })
  const t0 = Date.now()
  let last = 0
  for (const step of scenario.steps) {
    const extra = { ...(step.extra ?? {}), ...(step.pid === false ? {} : { prompt_id: pid }) }
    const send = step.send ?? step.at
    last = Math.max(last, send)
    setTimeout(() => fireLater(step.ev, extra, t0 + step.at), send)
  }
  await sleep(last + 1500)
  record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `replayed ${name}` }] } })
  log(`replay done ${name}`)
  busy = false
  process.stdout.write(`\r\nreplayed ${name}\r\n> `)
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
    if (buf === '\x1b') {
      buf = ''
      interrupt()
      return
    }
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
