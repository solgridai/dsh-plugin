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
  createAbortError,
  isLoginCommand,
  parseSkillMarkdown,
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
