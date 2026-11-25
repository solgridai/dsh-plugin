import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import {
  applyWithCli,
  buildCliEnv,
  buildNotReportedNotice,
  buildTimeoutNotice,
  createAbortError,
  extractRunId,
  firstPositionalCommand,
  isLoginCommand,
  isRunCommand,
  parseRunReport,
  parseSkillMarkdown,
  resolveTimeoutMs,
  shellQuote,
} from '../index.js'

const mockCliPath = fileURLToPath(new URL('./fixtures/mock-cli.js', import.meta.url))
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-solgrid-test-'))
const mockSkillFile = join(tempDir, 'SKILL.md')
writeFileSync(
  mockSkillFile,
  [
    '---',
    'name: solgrid-cli',
    'description: >-',
    '  Find and run third-party tools',
    '  through Solgrid.',
    '---',
    '',
    '# Solgrid CLI',
    '',
    'Original skill instructions.',
  ].join('\n'),
)

after(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

/**
 * Create a minimal mock Cordis context capturing skill/tool registrations and effects.
 * @param {{ workingDir?: string }} [opts]
 */
function createMockCtx(opts = {}) {
  /** @type {any[]} */
  const skills = []
  /** @type {any[]} */
  const tools = []
  /** @type {Array<() => void>} */
  const disposers = []

  const ctx = {
    skills: {
      /** @param {any} s */
      register(s) {
        skills.push(s)
        return () => {}
      },
    },
    tools: {
      /** @param {any} t */
      register(t) {
        tools.push(t)
        return () => {}
      },
    },
    /** @param {() => (() => void) | void} fn */
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    /** @param {string} service */
    get(service) {
      if (service === 'workingDirectory' && opts.workingDir) {
        return { ensure: async () => opts.workingDir }
      }
      return undefined
    },
  }

  return {
    ctx: /** @type {any} */ (ctx),
    skills,
    tools,
    dispose() {
      for (const d of disposers) d()
    },
  }
}

/** @param {AbortSignal} [signal] */
function makeExec(signal = new AbortController().signal) {
  return /** @type {any} */ ({
    callId: 'call-1',
    name: 'solgrid',
    arguments: {},
    agent: { id: 'agent-1' },
    signal,
  })
}

describe('parseSkillMarkdown', () => {
  it('parses folded multi-line YAML descriptions', () => {
    const raw = '---\nname: solgrid-cli\ndescription: >-\n  Line one\n  line two.\n---\n# Body\n'
    const res = parseSkillMarkdown(raw)
    assert.equal(res.description, 'Line one line two.')
    assert.equal(res.body, '# Body\n')
  })

  it('parses single-line quoted descriptions', () => {
    const raw = '---\nname: x\ndescription: "Single line"\n---\nHello'
    const res = parseSkillMarkdown(raw)
    assert.equal(res.description, 'Single line')
    assert.equal(res.body, 'Hello')
  })

  it('falls back when frontmatter is absent', () => {
    const res = parseSkillMarkdown('# Plain')
    assert.match(res.description, /Solgrid/)
    assert.equal(res.body, '# Plain')
  })
})

describe('command detection', () => {
  it('finds the subcommand after root-level global options', () => {
    assert.equal(firstPositionalCommand(['--lang', 'zh', 'run', '-p', 'x']), 'run')
    assert.equal(firstPositionalCommand(['--lang=zh', 'whoami']), 'whoami')
    assert.equal(firstPositionalCommand(['-v', 'run', '-p', 'x']), 'run')
    assert.equal(firstPositionalCommand(['discover', '-q', 'twitter']), 'discover')
    assert.equal(firstPositionalCommand(['run', '--lang', 'en', 'discover']), 'run')
    assert.equal(firstPositionalCommand([]), undefined)
  })

  it('detects login invocations with or without leading flags', () => {
    assert.equal(isLoginCommand(['login']), true)
    assert.equal(isLoginCommand(['--lang', 'zh', 'login', '--json']), true)
    assert.equal(isLoginCommand(['discover', '-q', 'login']), false)
    assert.equal(isLoginCommand([]), false)
  })

  it('detects run invocations, including help requests (env is inert on help)', () => {
    assert.equal(isRunCommand(['run', '-p', 'x', '-e', 'y']), true)
    assert.equal(isRunCommand(['--lang', 'zh', 'run', '--json']), true)
    assert.equal(isRunCommand(['run', '--help']), true)
    assert.equal(isRunCommand(['discover', '-q', 'run']), false)
    assert.equal(isRunCommand([]), false)
  })
})

describe('timeout notices', () => {
  it('reports the exact key the CLI reported, without caveats', () => {
    const notice = buildTimeoutNotice({ timeoutMs: 1_000, idempotencyKey: 'job wait=1' })
    assert.match(notice, /WAIT_TIMEOUT/)
    assert.match(notice, /idempotencyKey: job wait=1/)
    assert.match(notice, /--idempotency-key 'job wait=1' --wait --json/)
    assert.doesNotMatch(notice, /last occurrence/)

    const withRunId = buildTimeoutNotice({ timeoutMs: 1_000, idempotencyKey: 'k', runId: 'abc' })
    assert.match(withRunId, /runId: abc/)
    assert.match(withRunId, /runs get -r abc --wait --json/)
  })

  it('quotes the recovery command so keys with spaces survive copy-paste', () => {
    const notice = buildTimeoutNotice({ timeoutMs: 1_000, idempotencyKey: 'job wait=1' })
    assert.match(notice, /idempotencyKey: job wait=1/)
    assert.match(notice, /--idempotency-key 'job wait=1' --wait --json/)
  })

  it('quotes only what a POSIX shell would split', () => {
    assert.equal(shellQuote('01a21090-8ab3-70b1-bd3a-3b83768f0741'), '01a21090-8ab3-70b1-bd3a-3b83768f0741')
    assert.equal(shellQuote('step-1'), 'step-1')
    assert.equal(shellQuote('job wait=1'), "'job wait=1'")
    assert.equal(shellQuote("it's"), "'it'\\''s'")
    assert.equal(shellQuote('a\nb'), "'a\nb'")
  })

  it('says nothing was submitted when the CLI was killed before reporting', () => {
    const notice = buildNotReportedNotice(1_000)
    assert.match(notice, /WAIT_TIMEOUT/)
    assert.match(notice, /before it reported its idempotency key/)
    assert.match(notice, /no run was started/)
    assert.match(notice, /re-running the identical command is safe/)
  })
})

describe('parseRunReport', () => {
  it('parses the JSON report line', () => {
    assert.deepEqual(parseRunReport('solgrid: {"idempotencyKey":"abc","wait":30}\n'), {
      idempotencyKey: 'abc',
      waitSeconds: 30,
    })
  })

  it('carries keys with spaces and = losslessly, exactly like the CLI writes them', () => {
    assert.deepEqual(parseRunReport('solgrid: {"idempotencyKey":"job wait=1","wait":30}'), {
      idempotencyKey: 'job wait=1',
      waitSeconds: 30,
    })
  })

  it('parses wait-only reports and finds the line among other output', () => {
    assert.deepEqual(parseRunReport('noise\nsolgrid: {"wait":300}\nmore noise'), {
      idempotencyKey: undefined,
      waitSeconds: 300,
    })
  })

  it('ignores truncated lines, other solgrid lines, garbage and empty text', () => {
    assert.equal(parseRunReport('solgrid: {"idempotencyKey":"ab'), undefined) // split chunk
    assert.equal(parseRunReport('solgrid: update available 0.7.0\n'), undefined)
    assert.equal(parseRunReport('solgrid: not json\n'), undefined)
    assert.equal(parseRunReport('Error: nope\n'), undefined)
    assert.equal(parseRunReport(''), undefined)
  })
})

describe('resolveTimeoutMs', () => {
  it('extends to cover reported wait budgets and clamps below setTimeout overflow', () => {
    assert.equal(resolveTimeoutMs(1_000, undefined), 1_000)
    assert.equal(resolveTimeoutMs(1_000, 30), 45_000)
    assert.equal(resolveTimeoutMs(120_000, 30), 120_000)
    assert.equal(resolveTimeoutMs(300, 1e9), 2_147_483_000)
    assert.equal(resolveTimeoutMs(1e15, undefined), 2_147_483_000)
  })
})

describe('extractRunId', () => {
  it('extracts run IDs from partial JSON or text output', () => {
    const id = '01a21090-8ab3-70b1-bd3a-3b83768f0741'
    assert.equal(extractRunId(`{"runId":"${id}"}`), id)
    assert.equal(extractRunId(`Run ID:  ${id}`), id)
    assert.equal(extractRunId('Run submitted.'), undefined)
    assert.equal(extractRunId(''), undefined)
  })
})

describe('buildCliEnv', () => {
  it('inherits base env without overwriting when config fields are unset or blank', () => {
    const env = buildCliEnv(
      { apiBaseUrl: '   ' },
      { SOLGRID_API_BASE_URL: 'https://from-env.example', SOLGRID_LANG: 'zh' },
    )
    assert.equal(env.SOLGRID_API_BASE_URL, 'https://from-env.example')
    assert.equal(env.SOLGRID_LANG, 'zh')
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(env.NO_COLOR, '1')
    assert.equal(env.SOLGRID_NO_UPDATE_CHECK, '1')
  })

  it('respects explicit SOLGRID_NO_UPDATE_CHECK from base env', () => {
    const env = buildCliEnv({}, { SOLGRID_NO_UPDATE_CHECK: '' })
    assert.equal(env.SOLGRID_NO_UPDATE_CHECK, '')
  })

  it('applies explicit config overrides above inherited env', () => {
    const env = buildCliEnv(
      { apiBaseUrl: 'https://override.example', lang: 'en' },
      { SOLGRID_API_BASE_URL: 'https://from-env.example', SOLGRID_LANG: 'zh' },
    )
    assert.equal(env.SOLGRID_API_BASE_URL, 'https://override.example')
    assert.equal(env.SOLGRID_LANG, 'en')
  })
})

describe('createAbortError', () => {
  it('propagates an Error signal.reason verbatim', () => {
    const ac = new AbortController()
    const custom = new DOMException('cancelled by caller', 'AbortError')
    ac.abort(custom)
    assert.equal(createAbortError(ac.signal, 'fallback'), custom)
  })

  it('returns an AbortError DOMException when reason is not an Error', () => {
    const err = createAbortError(undefined, 'stopped')
    assert.equal(err.name, 'AbortError')
  })
})

describe('solgrid plugin integration', () => {
  const resolved = {
    version: '0.5.0',
    cliBin: mockCliPath,
    skillDir: tempDir,
    skillFile: mockSkillFile,
  }

  it('registers solgrid-cli skill with DSH preamble and solgrid tool', () => {
    const { ctx, skills, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      assert.equal(skills.length, 1)
      assert.equal(skills[0].name, 'solgrid-cli')
      assert.equal(skills[0].description, 'Find and run third-party tools through Solgrid.')
      assert.match(skills[0].content, /DeepSeek Harness/)
      assert.match(skills[0].content, /Original skill instructions\./)

      assert.equal(tools.length, 1)
      assert.equal(tools[0].name, 'solgrid')
      const callView = tools[0].presentCall({ args: ['discover', '-q', 'twitter'] })
      assert.deepEqual(callView, {
        card: 'generic',
        title: 'solgrid discover -q twitter',
        rawInput: { args: ['discover', '-q', 'twitter'] },
      })
    } finally {
      dispose()
    }
  })

  it('executes bundled CLI with config overrides and session workingDirectory', async () => {
    const { ctx, tools, dispose } = createMockCtx({ workingDir: tempDir })
    applyWithCli(ctx, { apiBaseUrl: 'https://api.example', lang: 'zh' }, resolved)
    try {
      const res = await tools[0].execute({ args: ['echo', '--json'] }, makeExec())
      assert.equal(res.status, 'ok')
      assert.equal(res.exitCode, 0)
      const parsed = JSON.parse(res.stdout)
      assert.deepEqual(parsed.args, ['echo', '--json'])
      assert.equal(realpathSync(parsed.cwd), realpathSync(tempDir))
      assert.equal(parsed.apiBaseUrl, 'https://api.example')
      assert.equal(parsed.lang, 'zh')
      assert.equal(parsed.electronRunAsNode, '1')
    } finally {
      dispose()
    }
  })

  it('returns non-zero exit codes as canonical values rather than throwing', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute({ args: ['fail'] }, makeExec())
      assert.equal(res.status, 'error')
      assert.equal(res.exitCode, 1)
      assert.match(res.stdout, /AUTH_FAILED/)
      assert.match(res.stderr, /not authenticated/)
    } finally {
      dispose()
    }
  })

  it('rejects invalid arguments with ToolArgsError', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      await assert.rejects(
        () => tools[0].execute({ args: [] }, makeExec()),
        (err) => err instanceof ToolArgsError,
      )
      await assert.rejects(
        () => tools[0].execute({ args: ['echo'], timeoutMs: 0 }, makeExec()),
        (err) => err instanceof ToolArgsError,
      )
      await assert.rejects(
        () => tools[0].execute({ args: ['echo'], cwd: '   ' }, makeExec()),
        (err) => err instanceof ToolArgsError,
      )
    } finally {
      dispose()
    }
  })

  it('propagates AbortError when signal is aborted before or during execution', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const preAborted = new AbortController()
      preAborted.abort()
      await assert.rejects(
        () => tools[0].execute({ args: ['echo'] }, makeExec(preAborted.signal)),
        (err) => err instanceof Error && err.name === 'AbortError',
      )

      const midFlight = new AbortController()
      const promise = tools[0].execute({ args: ['sleep', '10000'] }, makeExec(midFlight.signal))
      setTimeout(() => midFlight.abort(), 100)
      await assert.rejects(
        () => promise,
        (err) => err instanceof Error && err.name === 'AbortError',
      )
    } finally {
      dispose()
    }
  })

  it('returns timeout status without a recovery notice for non-run commands', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute({ args: ['sleep', '10000'], timeoutMs: 150 }, makeExec())
      assert.equal(res.status, 'timeout')
      assert.equal(res.hint, undefined)
    } finally {
      dispose()
    }
  })

  it('passes arguments through verbatim and echoes the generated key', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute(
        { args: ['run', '-p', 'x', '-e', 'y', '--json'] },
        makeExec(),
      )
      assert.equal(res.status, 'ok')
      const parsed = JSON.parse(res.stdout)
      assert.deepEqual(parsed.args, ['run', '-p', 'x', '-e', 'y', '--json']) // argv untouched
      assert.equal(parsed.key, 'mock-generated-key') // the CLI generated and reported it
    } finally {
      dispose()
    }
  })

  it('reports an explicit --idempotency-key as the resolved key', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute(
        { args: ['run', '--idempotency-key', 'agent-key-1', '--json'] },
        makeExec(),
      )
      assert.equal(res.status, 'ok')
      const parsed = JSON.parse(res.stdout)
      assert.deepEqual(parsed.args, ['run', '--idempotency-key', 'agent-key-1', '--json'])
      assert.equal(parsed.key, 'agent-key-1')
    } finally {
      dispose()
    }
  })

  it('re-arms the timeout when the CLI reports a wait budget', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      // Mock finishes ~1.3s in; without the re-arm the 200ms safety net would kill it first.
      const res = await tools[0].execute({ args: ['run', '--wait', '1'], timeoutMs: 200 }, makeExec())
      assert.equal(res.status, 'ok')

      const lookup = await tools[0].execute(
        { args: ['runs', 'get', '-r', 'run_01', '--wait', '1'], timeoutMs: 200 },
        makeExec(),
      )
      assert.equal(lookup.status, 'ok')
    } finally {
      dispose()
    }
  })

  it('parses the report from the raw stream even when the display stderr is truncated', async () => {
    // P2 regression: 2KB of noise before the report line + a 1KB display cap. The display
    // buffer fills first and drops the report; parsing must read the raw stream instead, or
    // the killed run would be misreported as "never submitted" — a duplicate-billing hazard.
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, { maxOutputChars: 1024 }, resolved)
    try {
      const res = await tools[0].execute(
        { args: ['run', '--noisy', '--hang'], timeoutMs: 150 },
        makeExec(),
      )
      assert.equal(res.status, 'timeout')
      assert.doesNotMatch(res.hint, /no run was started/) // the report was found in the raw stream
      assert.match(res.hint, /idempotencyKey: mock-generated-key/)
      assert.match(res.hint, /runs get --idempotency-key mock-generated-key --wait --json/)
      assert.ok(!res.stderr.includes('solgrid:')) // display output stayed truncated
    } finally {
      dispose()
    }
  })

  it('returns an exact recovery hint naming the reported key when a run is killed', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute({ args: ['run', '--hang'], timeoutMs: 200 }, makeExec())
      assert.equal(res.status, 'timeout')
      assert.equal(res.exitCode, 1)
      assert.equal(res.stdout, '')
      assert.match(res.stderr, /^solgrid: \{"idempotencyKey":"mock-generated-key"\}$/)
      assert.match(res.hint, /WAIT_TIMEOUT/)
      assert.match(res.hint, /idempotencyKey: mock-generated-key/)
      assert.match(res.hint, /runs get --idempotency-key mock-generated-key --wait --json/)
      assert.doesNotMatch(res.hint, /last occurrence/) // reported key: exact, no caveats

      const rendered = tools[0].output.render({ args: ['run', '--hang'] }, res)
      assert.match(rendered[0].text, /status: timeout/)
      assert.match(rendered[0].text, /WAIT_TIMEOUT/)
    } finally {
      dispose()
    }
  })

  it('says nothing was submitted when killed before the CLI reported', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      // --silent-hang: the child hangs before writing the report line — by protocol, before
      // any submission — so the recovery notice must say re-running is safe, without a key.
      const res = await tools[0].execute(
        { args: ['run', '--silent-hang'], timeoutMs: 150 },
        makeExec(),
      )
      assert.equal(res.status, 'timeout')
      assert.equal(res.stderr, '')
      assert.match(res.hint, /before it reported its idempotency key/)
      assert.match(res.hint, /no run was started/)
      assert.doesNotMatch(res.hint, /idempotencyKey: /)
    } finally {
      dispose()
    }
  })

  it('names an explicitly passed key exactly in the timeout hint', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      // The CLI resolves and reports the key itself; even killed, the hint is exact.
      // Keys containing spaces round-trip losslessly through the JSON report line.
      const res = await tools[0].execute(
        { args: ['run', '--hang', '--idempotency-key', 'agent-key-2'], timeoutMs: 150 },
        makeExec(),
      )
      assert.equal(res.status, 'timeout')
      assert.match(res.hint, /idempotencyKey: agent-key-2/)
      assert.doesNotMatch(res.hint, /last occurrence/)

      const spaced = await tools[0].execute(
        { args: ['run', '--hang', '--idempotency-key', 'job wait=1', '--wait', '30'], timeoutMs: 150 },
        makeExec(),
      )
      assert.equal(spaced.status, 'timeout')
      assert.match(spaced.hint, /idempotencyKey: job wait=1/)
    } finally {
      dispose()
    }
  })

  it('handles non-blocking device-code login and cleans up background process on dispose', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const start = Date.now()
      const res = await tools[0].execute({ args: ['login', '--json'] }, makeExec())
      const elapsed = Date.now() - start
      assert.equal(res.status, 'pending_approval')
      assert.equal(res.exitCode, 0)
      assert.match(res.stderr, /TEST-1234/)
      assert.ok(elapsed < 5_000, `login should return immediately, took ${elapsed}ms`)

      const rendered = tools[0].output.render({ args: ['login', '--json'] }, res)
      assert.match(rendered[0].text, /TEST-1234/)
      assert.match(rendered[0].text, /polling in the background/)
    } finally {
      dispose()
    }
  })

  it('surfaces immediate login failure as error status', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute({ args: ['login', '--fail'] }, makeExec())
      assert.equal(res.status, 'error')
      assert.equal(res.exitCode, 1)
      assert.match(res.stderr, /network error/)
    } finally {
      dispose()
    }
  })
})
