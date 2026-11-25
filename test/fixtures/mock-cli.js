#!/usr/bin/env node
// Minimal mock CLI for unit tests.
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
} else if (cmd === 'run') {
  // Simulate the real CLI: `--wait N` finishes just after the budget; `--hang` stalls forever.
  if (args.includes('--hang')) {
    setTimeout(() => process.exit(0), 60_000)
  } else {
    let waitSeconds
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--wait' || args[i] === '-w') {
        const next = args[i + 1]
        waitSeconds = typeof next === 'string' && /^\d+$/.test(next) ? Number(next) : 300
      } else if (args[i].startsWith('--wait=')) {
        waitSeconds = Number(args[i].slice('--wait='.length))
      }
    }
    const delay = waitSeconds !== undefined ? waitSeconds * 1000 + 300 : 0
    setTimeout(() => {
      console.log(JSON.stringify({ args }))
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
