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
  buildTimeoutNotice,
  createAbortError,
  extractRunId,
  extractWaitSeconds,
  firstPositionalCommand,
  hasHelpRequest,
  hasOutputOption,
  isLoginCommand,
  isRunCommand,
  localTokens,
  parseSkillMarkdown,
  prepareRunInvocation,
  resolveTimeoutMs,
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

describe('isLoginCommand', () => {
  it('detects login invocations with or without leading flags', () => {
    assert.equal(isLoginCommand(['login']), true)
    assert.equal(isLoginCommand(['--lang', 'zh', 'login', '--json']), true)
  })

  it('ignores help requests and other commands', () => {
    assert.equal(isLoginCommand(['login', '--help']), false)
    assert.equal(isLoginCommand(['login', '-h']), false)
    assert.equal(isLoginCommand(['discover', '-q', 'login']), false)
    assert.equal(isLoginCommand([]), false)
  })
})

describe('run invocation preparation', () => {
  it('strips global options anywhere until --, then passes the rest verbatim', () => {
    // --lang <code> is extracted by the root program even between subcommand arguments
    const local = localTokens(['run', '-p', 'x', '--lang', 'en', '-e', 'y'])
    assert.deepEqual(
      local.map((t) => t.text),
      ['run', '-p', 'x', '-e', 'y'],
    )
    assert.deepEqual(
      local.map((t) => t.index),
      [0, 1, 2, 5, 6],
    )
    assert.deepEqual(localTokens(['run', '--lang=en', '-v', '--json']).map((t) => t.text), ['run', '--json'])
    // at -- stripping stops; the separator and everything after pass through verbatim — the
    // subcommand scanner decides whether that -- is a value (e.g. -o --) or a separator
    assert.deepEqual(
      localTokens(['run', '--', '--lang', 'en']).map((t) => t.text),
      ['run', '--', '--lang', 'en'],
    )
  })

  it('finds the subcommand after global options', () => {
    assert.equal(firstPositionalCommand(['--lang', 'zh', 'run', '-p', 'x']), 'run')
    assert.equal(firstPositionalCommand(['--lang=zh', 'whoami']), 'whoami')
    assert.equal(firstPositionalCommand(['run', '--lang', 'en', 'discover']), 'run')
    assert.equal(firstPositionalCommand(['discover', '-q', 'twitter']), 'discover')
    assert.equal(firstPositionalCommand([]), undefined)
  })

  it('detects run commands, including ones whose --help is merely a value', () => {
    assert.equal(isRunCommand(['run', '-p', 'x', '-e', 'y']), true)
    assert.equal(isRunCommand(['--lang', 'zh', 'run', '--json']), true)
    assert.equal(isRunCommand(['run', '-o', '--help']), true) // --help is the output file name
    assert.equal(isRunCommand(['run', '--help']), true) // prepending is harmless: help exits first
    assert.equal(isRunCommand(['discover', '-q', 'run']), false)
    assert.equal(isRunCommand([]), false)
  })

  it('detects help requests only as real option occurrences, not as values', () => {
    assert.equal(hasHelpRequest(['run', '--help']), true)
    assert.equal(hasHelpRequest(['run', '-h']), true)
    assert.equal(hasHelpRequest(['run', '-ho']), true) // -h flag followed by -o
    assert.equal(hasHelpRequest(['run', '-o', '--help']), false) // output file named "--help"
    assert.equal(hasHelpRequest(['run', '--output', '--help']), false)
    assert.equal(hasHelpRequest(['run', '-i', '-h']), false)
    assert.equal(hasHelpRequest(['run', '--', '--help']), false) // operand after separator
  })

  it('reads wait budgets across a -- consumed as an option value', () => {
    // Round-4 shape: -o eats the --, so --wait stays a live option for the CLI.
    assert.equal(extractWaitSeconds(['run', '-p', 'x', '-e', 'y', '-o', '--', '--wait', '30', '--json']), 30)
    assert.equal(hasOutputOption(['run', '-o', '--', '--json']), true)
    // a real separator still ends option parsing
    assert.equal(extractWaitSeconds(['run', '-p', 'x', '--', '--wait', '9']), undefined)
  })

  it('extracts wait budgets in all spellings, last occurrence wins', () => {
    assert.equal(extractWaitSeconds(['run', '--wait', '30']), 30)
    assert.equal(extractWaitSeconds(['run', '--wait=45']), 45)
    assert.equal(extractWaitSeconds(['run', '-w', '60']), 60)
    assert.equal(extractWaitSeconds(['run', '-w90']), 90)
    assert.equal(extractWaitSeconds(['run', '--wait']), 300)
    assert.equal(extractWaitSeconds(['run', '--wait', '--json']), 300) // next token is an option: bare
    assert.equal(extractWaitSeconds(['runs', 'get', '-r', 'abc', '--wait', '5']), 5)
    assert.equal(extractWaitSeconds(['run', '--wait', '600', '--wait', '30']), 30)
    assert.equal(extractWaitSeconds(['discover']), undefined)
    // a numeric value of another option must not be misread
    assert.equal(extractWaitSeconds(['run', '-i', '{"wait":"--wait 9"}']), undefined)
    assert.equal(extractWaitSeconds(['run', '--', '--wait', '9']), undefined)
  })

  it('parses wait numbers exactly like the CLI parsePositiveInt', () => {
    assert.equal(extractWaitSeconds(['run', '--wait=600.0']), 600)
    assert.equal(extractWaitSeconds(['run', '--wait=6e2']), 600)
    assert.equal(extractWaitSeconds(['run', '--wait', '600.0']), 600)
    assert.equal(extractWaitSeconds(['run', '--wait=0x254']), 596)
    assert.equal(extractWaitSeconds(['run', '--wait=abc']), undefined)
    assert.equal(extractWaitSeconds(['run', '--wait=0']), undefined)
    assert.equal(extractWaitSeconds(['run', '--wait=']), undefined)
    assert.equal(extractWaitSeconds(['run', '--wait', '-5']), undefined)
  })

  it('reads wait budgets across interleaved global options like the CLI', () => {
    // `--wait --lang en 600`: the root program strips `--lang en`, so --wait consumes 600.
    assert.equal(extractWaitSeconds(['run', '-p', 'x', '-e', 'y', '--wait', '--lang', 'en', '600', '--json']), 600)
    assert.equal(extractWaitSeconds(['run', '--wait', '--lang', 'en', 'abc']), undefined)
    assert.equal(extractWaitSeconds(['run', '--lang=en', '--wait', '5']), 5)
  })

  it('understands combined short groups and rejects values the CLI rejects', () => {
    assert.equal(extractWaitSeconds(['run', '-jw600']), 600)
    assert.equal(extractWaitSeconds(['run', '-jw']), 300)
    assert.equal(extractWaitSeconds(['run', '-wj600']), undefined) // value 'j600': CLI usage error
    assert.equal(extractWaitSeconds(['run', '-w=30']), undefined) // commander keeps raw '=30'
    assert.equal(hasOutputOption(['run', '-oout.json']), true)
    assert.equal(hasOutputOption(['run', '-jo']), true)
  })

  it('detects output options that imply waiting', () => {
    assert.equal(hasOutputOption(['run', '-o', 'out.json']), true)
    assert.equal(hasOutputOption(['run', '--output=out.json']), true)
    assert.equal(hasOutputOption(['run', '--output', 'out.json']), true)
    assert.equal(hasOutputOption(['run', '-i', '{"o":"-o"}']), false)
  })

  it('prepends a generated idempotency key after the subcommand name, unconditionally', () => {
    const injected = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '--wait', '30'])
    assert.ok(injected.idempotencyKey !== undefined)
    assert.match(injected.idempotencyKey, /^[0-9a-f-]{36}$/)
    assert.deepEqual(injected.cliArgs, [
      'run',
      '--idempotency-key',
      injected.idempotencyKey,
      '-p',
      'x',
      '-e',
      'y',
      '--wait',
      '30',
    ])
    assert.equal(injected.waitSeconds, 30)

    // after global options, the key lands right after the subcommand name
    const withLang = prepareRunInvocation(['--lang', 'zh', 'run', '--json'])
    assert.deepEqual(withLang.cliArgs, ['--lang', 'zh', 'run', '--idempotency-key', withLang.idempotencyKey, '--json'])

    const untouched = prepareRunInvocation(['discover', '-q', 'twitter', '--json'])
    assert.equal(untouched.idempotencyKey, undefined)
    assert.deepEqual(untouched.cliArgs, ['discover', '-q', 'twitter', '--json'])
  })

  it('lets the CLI resolve key precedence: an explicit key always overrides the injected one', () => {
    // commander last-wins: the agent's later key is the effective one (probed against the CLI)
    const explicit = prepareRunInvocation(['run', '--idempotency-key', 'mine'])
    assert.deepEqual(explicit.cliArgs, ['run', '--idempotency-key', explicit.idempotencyKey, '--idempotency-key', 'mine'])

    const lastWins = prepareRunInvocation(['run', '--idempotency-key', 'old', '--idempotency-key', 'actual'])
    assert.deepEqual(lastWins.cliArgs, [
      'run',
      '--idempotency-key',
      lastWins.idempotencyKey,
      '--idempotency-key',
      'old',
      '--idempotency-key',
      'actual',
    ])

    // an explicit empty key stays effective (last) and is rejected by the CLI with USAGE
    const empty = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '--idempotency-key', ''])
    assert.deepEqual(empty.cliArgs, ['run', '--idempotency-key', empty.idempotencyKey, '-p', 'x', '-e', 'y', '--idempotency-key', ''])

    // interleaved globals and a -- consumed as -o's value: the agent's key is still last-wins
    const interleaved = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '--idempotency-key', '--lang', 'en', 'actual-key', '--json'])
    assert.deepEqual(interleaved.cliArgs.slice(3), ['-p', 'x', '-e', 'y', '--idempotency-key', '--lang', 'en', 'actual-key', '--json'])

    const round4 = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '-o', '--', '--idempotency-key', 'retry-key', '--json'])
    assert.deepEqual(round4.cliArgs, [
      'run',
      '--idempotency-key',
      round4.idempotencyKey,
      '-p',
      'x',
      '-e',
      'y',
      '-o',
      '--',
      '--idempotency-key',
      'retry-key',
      '--json',
    ])
  })

  it('prepends before any -- separator, so the key stays an option', () => {
    const bare = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '--'])
    assert.deepEqual(bare.cliArgs, ['run', '--idempotency-key', bare.idempotencyKey, '-p', 'x', '-e', 'y', '--'])

    const operands = prepareRunInvocation(['run', '--', 'a', 'b'])
    assert.deepEqual(operands.cliArgs.slice(0, 3), ['run', '--idempotency-key', operands.idempotencyKey])
    assert.deepEqual(operands.cliArgs.slice(-3), ['--', 'a', 'b'])

    // -o consumes the -- as its value; the prepended key is still a leading option
    const consumed = prepareRunInvocation(['run', '-o', '--'])
    assert.deepEqual(consumed.cliArgs, ['run', '--idempotency-key', consumed.idempotencyKey, '-o', '--'])
  })

  it('applies the -o implied wait with combined shorts and help-as-value', () => {
    const attached = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '-oout.json'])
    assert.equal(attached.waitSeconds, 300)

    const combined = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '-jw600'])
    assert.equal(combined.waitSeconds, 600)

    const helpAsValue = prepareRunInvocation(['run', '-o', '--help'])
    assert.ok(helpAsValue.idempotencyKey !== undefined)
    assert.equal(helpAsValue.waitSeconds, 300)
  })

  it('extends the timeout to cover declared wait budgets and clamps below setTimeout overflow', () => {
    assert.equal(resolveTimeoutMs(1_000, undefined), 1_000)
    assert.equal(resolveTimeoutMs(1_000, 30), 45_000)
    assert.equal(resolveTimeoutMs(120_000, 30), 120_000)
    assert.equal(resolveTimeoutMs(300, 1e9), 2_147_483_000) // --wait=1000000000s would overflow
    assert.equal(resolveTimeoutMs(1e15, undefined), 2_147_483_000) // absurd requested timeout
  })

  it('extracts run IDs from partial JSON or text output', () => {
    const id = '01a21090-8ab3-70b1-bd3a-3b83768f0741'
    assert.equal(extractRunId(`{"runId":"${id}"}`), id)
    assert.equal(extractRunId(`Run ID:  ${id}`), id)
    assert.equal(extractRunId('Run submitted.'), undefined)
    assert.equal(extractRunId(''), undefined)
  })

  it('builds WAIT_TIMEOUT notices naming the key and recovery commands', () => {
    const notice = buildTimeoutNotice({ timeoutMs: 1_000, idempotencyKey: 'key-1', runId: undefined })
    assert.ok(notice !== undefined)
    assert.match(notice, /WAIT_TIMEOUT/)
    assert.match(notice, /idempotencyKey: key-1 \(auto-injected by this tool\)/)
    assert.match(notice, /runs get --idempotency-key key-1 --wait --json/)
    assert.match(notice, /its last occurrence is the effective key/)
    assert.match(notice, /NOT_FOUND/)

    const withRunId = buildTimeoutNotice({ timeoutMs: 1_000, idempotencyKey: 'key-1', runId: 'abc' })
    assert.ok(withRunId !== undefined)
    assert.match(withRunId, /runId: abc/)
    assert.match(withRunId, /runs get -r abc --wait --json/)

    assert.equal(buildTimeoutNotice({ timeoutMs: 1_000, idempotencyKey: undefined }), undefined)
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

  it('returns timeout status when command exceeds timeoutMs', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute({ args: ['sleep', '10000'], timeoutMs: 150 }, makeExec())
      assert.equal(res.status, 'timeout')
      assert.equal(res.hint, undefined) // non-run commands get no recovery notice
    } finally {
      dispose()
    }
  })

  it('prepends the injected idempotency key right after the subcommand name', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute({ args: ['run', '-p', 'x', '-e', 'y', '--json'] }, makeExec())
      assert.equal(res.status, 'ok')
      const parsed = JSON.parse(res.stdout)
      assert.equal(parsed.args[0], 'run')
      assert.equal(parsed.args[1], '--idempotency-key')
      assert.match(parsed.args[2], /^[0-9a-f-]{36}$/)
      assert.deepEqual(parsed.args.slice(3), ['-p', 'x', '-e', 'y', '--json'])
    } finally {
      dispose()
    }
  })

  it('leaves an explicit key in place — the CLI last-wins resolves it over the injected one', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute(
        { args: ['run', '--idempotency-key', 'agent-key-1'] },
        makeExec(),
      )
      assert.equal(res.status, 'ok')
      const parsed = JSON.parse(res.stdout)
      assert.equal(parsed.args[0], 'run')
      assert.equal(parsed.args[1], '--idempotency-key')
      assert.match(parsed.args[2], /^[0-9a-f-]{36}$/)
      assert.deepEqual(parsed.args.slice(3), ['--idempotency-key', 'agent-key-1'])
    } finally {
      dispose()
    }
  })

  it('extends the effective timeout to cover a declared --wait budget', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      // Mock finishes ~1.3s in; without extension the 200ms tool timeout would kill it first.
      const res = await tools[0].execute(
        { args: ['run', '--wait', '1'], timeoutMs: 200 },
        makeExec(),
      )
      assert.equal(res.status, 'ok')
    } finally {
      dispose()
    }
  })

  it('returns a WAIT_TIMEOUT recovery hint when a run is cut off by the tool timeout', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute({ args: ['run', '--hang'], timeoutMs: 200 }, makeExec())
      assert.equal(res.status, 'timeout')
      assert.equal(res.exitCode, 1)
      assert.equal(res.stdout, '')
      assert.match(res.hint, /WAIT_TIMEOUT/)
      assert.match(res.hint, /idempotencyKey: [0-9a-f-]{36}/)
      assert.match(res.hint, /runs get --idempotency-key [0-9a-f-]{36} --wait --json/)

      const rendered = tools[0].output.render({ args: ['run', '--hang'] }, res)
      assert.match(rendered[0].text, /status: timeout/)
      assert.match(rendered[0].text, /WAIT_TIMEOUT/)
    } finally {
      dispose()
    }
  })

  it('names a caller-provided idempotency key in the timeout hint', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      // The hint names the injected key and points at the command's own key when present —
      // the CLI resolves agent-key-2 as the effective key via last-wins.
      const res = await tools[0].execute(
        { args: ['run', '--hang', '--idempotency-key', 'agent-key-2'], timeoutMs: 150 },
        makeExec(),
      )
      assert.equal(res.status, 'timeout')
      assert.match(res.hint, /idempotencyKey: [0-9a-f-]{36} \(auto-injected by this tool\)/)
      assert.match(res.hint, /its last occurrence is the effective key/)
    } finally {
      dispose()
    }
  })

  it('recovers runs whose global options interleave or whose -- is a value', async () => {
    // Round-3 and round-4 shapes: the injected key leads, the agent's key stays effective.
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const interleaved = await tools[0].execute(
        {
          args: ['run', '-p', 'x', '-e', 'y', '--idempotency-key', '--lang', 'en', 'agent-key-3', '--hang'],
          timeoutMs: 150,
        },
        makeExec(),
      )
      assert.equal(interleaved.status, 'timeout')
      assert.match(interleaved.hint, /idempotencyKey: [0-9a-f-]{36}/)
      assert.match(interleaved.hint, /its last occurrence is the effective key/)

      const asValue = await tools[0].execute(
        {
          args: ['run', '-p', '--', '-e', 'y', '--idempotency-key', 'agent-key-4', '--hang'],
          timeoutMs: 150,
        },
        makeExec(),
      )
      assert.equal(asValue.status, 'timeout')
      assert.match(asValue.hint, /idempotencyKey: [0-9a-f-]{36}/)
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
