// Hook sequences fake-claude.js plays for a `REPLAY <name>` prompt: the orders and
// timings a real Claude produces only now and then, put to the app on demand. Each
// step is a hook, `at` — when Claude "emitted" it, in ms after the prompt (the stamp
// the reporter sends) — and `send`, when it is actually delivered (default: `at`).
// Every step carries the prompt's prompt_id unless `pid: false`. `expect` is the
// status `terminator list` must read once the last one has landed.
//
// They come from hook-trace.log lines of real sessions, where they could be had.
const bash = { tool_name: 'Bash' }

module.exports = {
  // A PostToolUse whose reporter was slow: emitted before Stop, delivered after it.
  'post-tool-delivered-after-stop': {
    expect: 'idle',
    steps: [
      { ev: 'PreToolUse', extra: bash, at: 100 },
      { ev: 'PostToolUse', extra: bash, at: 400, send: 1200 },
      { ev: 'Stop', at: 450, send: 500 },
    ],
  },
  // Stamped after Stop but part of the turn Stop ended (two hooks a beat apart).
  'tool-hook-stamped-after-stop': {
    expect: 'idle',
    steps: [
      { ev: 'PreToolUse', extra: bash, at: 100 },
      { ev: 'Stop', at: 400 },
      { ev: 'PostToolUse', extra: bash, at: 420, send: 700 },
    ],
  },
  // Seen for real: Claude fires a SubagentStop a moment after the turn's Stop.
  'subagent-stop-after-stop': {
    expect: 'idle',
    steps: [
      { ev: 'PreToolUse', extra: bash, at: 100 },
      { ev: 'PostToolUse', extra: bash, at: 300 },
      { ev: 'Stop', at: 500 },
      { ev: 'SubagentStop', extra: { agent_id: 'a1', agent_type: 'general-purpose' }, at: 1900 },
    ],
  },
  // The ~6 s permission notice, raised while the dialog was up, landing after the turn ended.
  'permission-notice-after-stop': {
    expect: 'idle',
    steps: [
      { ev: 'PreToolUse', extra: bash, at: 100 },
      { ev: 'PermissionRequest', extra: bash, at: 150 },
      { ev: 'PostToolUse', extra: bash, at: 800 },
      { ev: 'Stop', at: 900 },
      { ev: 'Notification', extra: { notification_type: 'permission_prompt', message: 'Claude needs your permission' }, at: 950, send: 1300 },
    ],
  },
  // A dialog still up when the replay ends: the status must say so.
  'permission-pending': {
    expect: 'waiting',
    steps: [
      { ev: 'PreToolUse', extra: bash, at: 100 },
      { ev: 'PermissionRequest', extra: bash, at: 150 },
      { ev: 'Notification', extra: { notification_type: 'permission_prompt', message: 'Claude needs your permission' }, at: 900 },
    ],
  },
  // The machine's clock stepped back 10 s mid-turn (NTP, waking from sleep): the
  // later hooks look old, but freezing the status on them would be worse.
  'clock-stepped-back': {
    expect: 'idle',
    steps: [
      { ev: 'PreToolUse', extra: bash, at: 100 },
      { ev: 'PostToolUse', extra: bash, at: -9_800, send: 300 },
      { ev: 'Stop', at: -9_700, send: 400 },
    ],
  },
  // A subagent finishing is not the turn finishing.
  subagent: {
    expect: 'working',
    steps: [
      { ev: 'PreToolUse', extra: { tool_name: 'Task' }, at: 100 },
      { ev: 'SubagentStart', extra: { agent_id: 'a1', agent_type: 'general-purpose' }, at: 200 },
      { ev: 'SubagentStop', extra: { agent_id: 'a1', agent_type: 'general-purpose' }, at: 600 },
    ],
  },
  // Compaction mid-turn: its SessionStart must not read as a fresh, idle session.
  'compact-mid-turn': {
    expect: 'working',
    steps: [
      { ev: 'PreToolUse', extra: bash, at: 100 },
      { ev: 'PreCompact', at: 200 },
      { ev: 'SessionStart', extra: { source: 'compact' }, at: 400, pid: false },
    ],
  },
  'stop-failure': {
    expect: 'error',
    steps: [
      { ev: 'PreToolUse', extra: bash, at: 100 },
      { ev: 'StopFailure', extra: { error: 'rate_limit', error_details: 'rate limited' }, at: 300 },
    ],
  },
  // The ~60 s "waiting for your input" nudge after a finished turn changes nothing.
  'idle-nudge-after-stop': {
    expect: 'idle',
    steps: [
      { ev: 'Stop', at: 100 },
      { ev: 'Notification', extra: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, at: 600 },
    ],
  },
}
