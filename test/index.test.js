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
  extractIdempotencyKey,
  extractRunId,
  extractWaitSeconds,
  firstPositionalCommand,
  hasHelpRequest,
  hasOutputOption,
  isLoginCommand,
  isRunCommand,
  parseSkillMarkdown,
  prepareRunInvocation,
  resolveTimeoutMs,
  separatorIndex,
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
  it('finds the subcommand after global options', () => {
    assert.equal(firstPositionalCommand(['--lang', 'zh', 'run', '-p', 'x']), 'run')
    assert.equal(firstPositionalCommand(['--lang=zh', 'whoami']), 'whoami')
    assert.equal(firstPositionalCommand(['discover', '-q', 'twitter']), 'discover')
    assert.equal(firstPositionalCommand([]), undefined)
  })

  it('detects run commands but not help or look-alikes', () => {
    assert.equal(isRunCommand(['run', '-p', 'x', '-e', 'y']), true)
    assert.equal(isRunCommand(['--lang', 'zh', 'run', '--json']), true)
    assert.equal(isRunCommand(['run', '--help']), false)
    assert.equal(isRunCommand(['discover', '-q', 'run']), false)
    assert.equal(isRunCommand([]), false)
  })

  it('detects help requests only as real option occurrences, not as values', () => {
    assert.equal(hasHelpRequest(['run', '--help']), true)
    assert.equal(hasHelpRequest(['run', '-h']), true)
    assert.equal(hasHelpRequest(['run', '-ho']), true) // -h flag followed by -o
    assert.equal(hasHelpRequest(['run', '-o', '--help']), false) // output file named "--help"
    assert.equal(hasHelpRequest(['run', '--output', '--help']), false)
    assert.equal(hasHelpRequest(['run', '--idempotency-key', '--help']), false) // key named "--help"
    assert.equal(hasHelpRequest(['run', '-i', '-h']), false)
    assert.equal(hasHelpRequest(['run', '--', '--help']), false) // operand after separator
  })

  it('treats runs whose --help is merely a value as paid runs', () => {
    assert.equal(isRunCommand(['run', '-o', '--help']), true)
    assert.equal(isRunCommand(['run', '--idempotency-key', '--help']), true)
    assert.equal(isRunCommand(['run', '--help']), false)
    assert.equal(isRunCommand(['run', '-h']), false)
  })

  it('finds separator positions, skipping -- consumed as values', () => {
    assert.equal(separatorIndex(['run', '-p', 'x', '--', 'operand']), 3)
    assert.equal(separatorIndex(['run', '-o', '--']), -1) // -- is the output file name
    assert.equal(separatorIndex(['run', '--wait', '--']), 2)
    assert.equal(separatorIndex(['run']), -1)
  })

  it('extracts explicit idempotency keys in both spellings, last occurrence wins', () => {
    assert.equal(extractIdempotencyKey(['run', '--idempotency-key', 'k1']), 'k1')
    assert.equal(extractIdempotencyKey(['run', '--idempotency-key=k2']), 'k2')
    assert.equal(
      extractIdempotencyKey(['run', '--idempotency-key', 'old', '--idempotency-key', 'actual']),
      'actual',
    )
    assert.equal(extractIdempotencyKey(['run', '--idempotency-key=a', '--idempotency-key', 'b']), 'b')
    assert.equal(
      extractIdempotencyKey(['run', '-i', '{"x":"--idempotency-key=trap"}', '--idempotency-key', 'k3']),
      'k3',
    )
    assert.equal(extractIdempotencyKey(['run', '--', '--idempotency-key', 'k']), undefined)
    assert.equal(extractIdempotencyKey(['discover', '-q', 'twitter']), undefined)
  })

  it('reports a present-but-empty key as null instead of absent', () => {
    assert.equal(extractIdempotencyKey(['run', '--idempotency-key', '']), null)
    assert.equal(extractIdempotencyKey(['run', '--idempotency-key=']), null)
    assert.equal(extractIdempotencyKey(['run', '--idempotency-key']), null) // CLI errors: argument missing
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

  it('injects a fresh idempotency key only for run commands lacking one', () => {
    const injected = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '--wait', '30'])
    assert.ok(injected.idempotencyKey !== undefined)
    assert.match(injected.idempotencyKey, /^[0-9a-f-]{36}$/)
    assert.deepEqual(injected.cliArgs.slice(0, -2), ['run', '-p', 'x', '-e', 'y', '--wait', '30'])
    assert.deepEqual(injected.cliArgs.slice(-2), ['--idempotency-key', injected.idempotencyKey])
    assert.equal(injected.waitSeconds, 30)

    const kept = prepareRunInvocation(['run', '--idempotency-key', 'mine'])
    assert.equal(kept.idempotencyKey, 'mine')
    assert.deepEqual(kept.cliArgs, ['run', '--idempotency-key', 'mine'])

    const lastWins = prepareRunInvocation(['run', '--idempotency-key', 'old', '--idempotency-key', 'actual'])
    assert.equal(lastWins.idempotencyKey, 'actual')
    assert.deepEqual(lastWins.cliArgs, ['run', '--idempotency-key', 'old', '--idempotency-key', 'actual'])

    const untouched = prepareRunInvocation(['discover', '-q', 'twitter', '--json'])
    assert.equal(untouched.idempotencyKey, undefined)
    assert.deepEqual(untouched.cliArgs, ['discover', '-q', 'twitter', '--json'])
  })

  it('does not replace an explicit empty key — the CLI must reject it untouched', () => {
    const empty = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '--idempotency-key', ''])
    assert.equal(empty.idempotencyKey, undefined)
    assert.deepEqual(empty.cliArgs, ['run', '-p', 'x', '-e', 'y', '--idempotency-key', ''])

    const trailing = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '--idempotency-key'])
    assert.equal(trailing.idempotencyKey, undefined)
    assert.deepEqual(trailing.cliArgs, ['run', '-p', 'x', '-e', 'y', '--idempotency-key'])
  })

  it('applies the -o implied wait with an explicit key and with combined shorts', () => {
    const withKey = prepareRunInvocation(['run', '-o', 'out.json', '--idempotency-key', 'known'])
    assert.equal(withKey.idempotencyKey, 'known')
    assert.equal(withKey.waitSeconds, 300)

    const attached = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '-oout.json'])
    assert.equal(attached.waitSeconds, 300)

    const combined = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '-jw600'])
    assert.equal(combined.waitSeconds, 600)

    const helpAsValue = prepareRunInvocation(['run', '-o', '--help'])
    assert.ok(helpAsValue.idempotencyKey !== undefined)
    assert.equal(helpAsValue.waitSeconds, 300)
  })

  it('inserts the injected key before the -- separator, never after it', () => {
    const bare = prepareRunInvocation(['run', '-p', 'x', '-e', 'y', '--'])
    assert.ok(bare.idempotencyKey !== undefined)
    assert.deepEqual(bare.cliArgs, ['run', '-p', 'x', '-e', 'y', '--idempotency-key', bare.idempotencyKey, '--'])

    const operands = prepareRunInvocation(['run', '--', 'a', 'b'])
    assert.deepEqual(
      operands.cliArgs.slice(0, 3),
      ['run', '--idempotency-key', operands.idempotencyKey],
    )
    assert.deepEqual(operands.cliArgs.slice(-3), ['--', 'a', 'b'])

    // a -- consumed as another option's value is not a separator: append at the end
    const consumed = prepareRunInvocation(['run', '-o', '--'])
    assert.deepEqual(consumed.cliArgs, ['run', '-o', '--', '--idempotency-key', consumed.idempotencyKey])
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
    assert.match(notice, /idempotencyKey: key-1/)
    assert.match(notice, /runs get --idempotency-key key-1 --wait --json/)
    assert.match(notice, /--idempotency-key key-1/)

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

  it('injects an idempotency key into run commands and passes it to the CLI', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute({ args: ['run', '-p', 'x', '-e', 'y', '--json'] }, makeExec())
      assert.equal(res.status, 'ok')
      const parsed = JSON.parse(res.stdout)
      assert.equal(parsed.args.length, 8)
      assert.equal(parsed.args[6], '--idempotency-key')
      assert.match(parsed.args[7], /^[0-9a-f-]{36}$/)
    } finally {
      dispose()
    }
  })

  it('keeps an explicit idempotency key untouched', async () => {
    const { ctx, tools, dispose } = createMockCtx()
    applyWithCli(ctx, {}, resolved)
    try {
      const res = await tools[0].execute(
        { args: ['run', '--idempotency-key', 'agent-key-1'] },
        makeExec(),
      )
      assert.equal(res.status, 'ok')
      const parsed = JSON.parse(res.stdout)
      assert.deepEqual(parsed.args, ['run', '--idempotency-key', 'agent-key-1'])
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
      const res = await tools[0].execute(
        { args: ['run', '--hang', '--idempotency-key', 'agent-key-2'], timeoutMs: 150 },
        makeExec(),
      )
      assert.equal(res.status, 'timeout')
      assert.match(res.hint, /idempotencyKey: agent-key-2/)
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
