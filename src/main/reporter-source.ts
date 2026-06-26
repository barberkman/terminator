// Source for the tiny reporter that Claude Code hooks + statusLine invoke. It is
// written to userData/reporter.cjs at startup and run via the app's own Electron
// binary in Node mode (ELECTRON_RUN_AS_NODE=1), so it needs no node/curl/python
// on PATH. It reads the hook/statusLine JSON from stdin and POSTs it to the
// loopback report server. argv: [exe, reporter.cjs, kind, port, token].
// Written with no template literals / ${} so it can live inside this TS string.

export const REPORTER_SOURCE = `'use strict'
const http = require('http')
const kind = process.argv[2] || 'hook'
const port = process.argv[3] || process.env.TERMINATOR_PORT
const token = process.argv[4] || process.env.TERMINATOR_TOKEN

let body = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', function (c) { body += c })
process.stdin.on('end', function () {
  if (kind === 'status') {
    try {
      const j = JSON.parse(body || '{}')
      const model = (j.model && (j.model.display_name || j.model.id)) || ''
      const cw = j.context_window || {}
      const pct = cw.used_percentage
      const cost = j.cost && j.cost.total_cost_usd
      let line = model
      if (pct !== undefined && pct !== null) line += '  ' + Math.round(pct) + '%'
      if (cost !== undefined && cost !== null) line += '  $' + Number(cost).toFixed(2)
      if (line) process.stdout.write(line)
    } catch (e) {}
  }
  send()
})
// Never hang Claude: hard-exit if stdin never closes.
setTimeout(function () { process.exit(0) }, 2500)

function send() {
  if (!port || !token) { process.exit(0); return }
  try {
    const data = Buffer.from(body || '{}')
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(port),
        path: '/' + kind,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          authorization: 'Bearer ' + token,
        },
      },
      function (res) {
        res.resume()
        res.on('end', function () { process.exit(0) })
      },
    )
    req.on('error', function () { process.exit(0) })
    req.setTimeout(1500, function () { req.destroy(); process.exit(0) })
    req.end(data)
  } catch (e) {
    process.exit(0)
  }
}
`
