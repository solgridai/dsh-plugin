#!/usr/bin/env node
// Minimal mock CLI for unit tests. Mirrors the real CLI's wrapper-recovery protocol:
// `--idempotency-key` beats SOLGRID_IDEMPOTENCY_KEY beats a generated key, and
// `solgrid: idempotencyKey=<key> wait=<seconds>` is written to stderr before any work.
const args = process.argv.slice(2)
const cmd = args[0]

if (cmd === 'echo') {
  console.log(
    JSON.stringify({
      args,
      cwd: process.cwd(),
      apiBaseUrl: process.env.SOLGRID_API_BASE_URL ?? null,
      lang: process.env.SOLGRID_LANG ?? null,
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    }),
  )
  process.exit(0)
}

if (cmd === 'fail') {
  console.log(JSON.stringify({ error: { code: 'AUTH_FAILED' } }))
  console.error('not authenticated')
  process.exit(1)
}

if (cmd === 'sleep') {
  const ms = Number(args[1] ?? 10_000)
  setTimeout(() => {
    console.log('awake')
    process.exit(0)
  }, ms)
} else if (cmd === 'run' || (cmd === 'runs' && args[1] === 'get')) {
  // Key resolution: explicit flag, then the preset env, then generated.
  let key
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--idempotency-key') {
      key = args[i + 1]
      break
    }
    if (args[i].startsWith('--idempotency-key=')) {
      key = args[i].slice('--idempotency-key='.length)
      break
    }
  }
  key = key ?? process.env.SOLGRID_IDEMPOTENCY_KEY ?? 'mock-generated-key'

  /** @type {number | undefined} */
  let wait
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--wait' || args[i] === '-w') {
      wait = /^\d+$/.test(args[i + 1] ?? '') ? Number(args[i + 1]) : 300
    } else if (args[i].startsWith('--wait=')) {
      wait = Number(args[i].slice('--wait='.length))
    }
  }

  const report = cmd === 'run' ? `solgrid: idempotencyKey=${key}${wait !== undefined ? ` wait=${wait}` : ''}` : `solgrid: wait=${wait ?? 300}`
  if (cmd === 'runs' && wait === undefined) {
    // runs get without --wait reports nothing and returns immediately.
    console.log(JSON.stringify({ args }))
    process.exit(0)
  }
  process.stderr.write(`${report}\n`)

  if (args.includes('--hang')) {
    setTimeout(() => process.exit(0), 60_000)
  } else {
    const delay = wait !== undefined ? wait * 1000 + 300 : 0
    setTimeout(() => {
      console.log(JSON.stringify({ args, ...(cmd === 'run' ? { key, wait: wait ?? null } : {}) }))
      process.exit(0)
    }, delay)
  }
} else if (cmd === 'login') {
  if (args.includes('--fail')) {
    console.error('network error')
    process.exit(1)
  }
  process.stderr.write(
    [
      'Authorize this CLI from a browser:',
      '',
      '  https://solgrid.ai/device?code=TEST-1234',
      '',
      '  …or open https://solgrid.ai/device and enter the code TEST-1234.',
      '  The code expires in 10 minutes.',
      '',
    ].join('\n'),
  )
  // Keep polling in the background until terminated or timeout.
  setTimeout(() => process.exit(0), 60_000)
} else {
  console.error(`unknown mock command: ${cmd}`)
  process.exit(2)
}
