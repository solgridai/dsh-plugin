/**
 * DeepSeek Harness (`dsh`) plugin bundle for Solgrid.
 *
 * Embeds `@solgridai/cli`, registers the `solgrid-cli` skill (at runtime rank),
 * and exposes a thin `solgrid` tool that executes the bundled CLI without
 * requiring a global installation or separate Node.js setup.
 *
 * @module @solgridai/dsh-plugin
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** @import { ChildProcess } from 'node:child_process' */
/** @import { Context } from '@deepseek-ai/cordis' */
/** @import {} from '@deepseek-ai/dsh-skill' */
/** @import {} from '@deepseek-ai/dsh-working-directory' */

const require = createRequire(import.meta.url)

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_LOGIN_BANNER_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_CHARS = 200_000
const SIGKILL_GRACE_MS = 2_000

const DSH_SKILL_PREAMBLE = `> **DeepSeek Harness (\`dsh\`) runtime note:** Use the built-in \`solgrid\` tool instead of running \`solgrid\` through \`bash\`. Pass CLI arguments as the \`args\` array (for example \`{ "args": ["discover", "-q", "twitter user profile", "--json"] }\`). The CLI is bundled with this plugin, so no separate installation is needed.
>
> For device-code login, call \`solgrid\` with \`{ "args": ["login", "--json"] }\`: it returns the authorization link and code immediately while polling in the background. Relay the link and code to the user; once they approve in their browser, run \`{ "args": ["whoami", "--json"] }\` or re-run the command that failed.

`

/**
 * @typedef {object} PluginConfig
 * @property {string} [apiBaseUrl]
 * @property {'en' | 'zh'} [lang]
 * @property {number} [defaultTimeoutMs]
 * @property {number} [loginBannerTimeoutMs]
 * @property {number} [maxOutputChars]
 */

/**
 * @typedef {object} ResolvedCli
 * @property {string} version
 * @property {string} cliBin
 * @property {string} skillDir
 * @property {string} skillFile
 */

/**
 * @typedef {object} CliRunResult
 * @property {'ok' | 'error' | 'timeout' | 'pending_approval'} status
 * @property {number} exitCode
 * @property {string} stdout
 * @property {string} stderr
 */

/** Cordis plugin name. */
export const name = 'solgrid'

/** Required DSH services. */
export const inject = ['tools', 'skills']

/** Plugin configuration schema. */
export const Config = z.object({
  apiBaseUrl: z
    .string()
    .description(
      'Optional Solgrid API base URL override. Leave blank to follow SOLGRID_API_BASE_URL or the CLI default.',
    ),
  lang: z
    .union(['en', 'zh'])
    .description(
      'Optional language for Solgrid server messages and labels. Leave unset to follow SOLGRID_LANG or the CLI default.',
    ),
  defaultTimeoutMs: z
    .number()
    .min(1_000)
    .default(DEFAULT_TIMEOUT_MS)
    .description('Default command timeout in milliseconds (default: 300000).'),
  loginBannerTimeoutMs: z
    .number()
    .min(1_000)
    .default(DEFAULT_LOGIN_BANNER_TIMEOUT_MS)
    .description(
      'Maximum wait in milliseconds for `solgrid login` to print the authorization link and code (default: 15000).',
    ),
  maxOutputChars: z
    .number()
    .min(1_024)
    .default(DEFAULT_MAX_OUTPUT_CHARS)
    .description('Maximum characters captured per stdout/stderr stream (default: 200000).'),
})

/**
 * Locate the bundled `@solgridai/cli` binary and skill directory.
 * @returns {ResolvedCli}
 */
export function resolveSolgridCli() {
  const pkgJsonPath = require.resolve('@solgridai/cli/package.json')
  const pkgDir = dirname(pkgJsonPath)
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.solgrid ?? 'dist/index.js'
  const cliBin = join(pkgDir, binRel)
  const skillDir = join(pkgDir, 'skills', 'solgrid-cli')
  const skillFile = join(skillDir, 'SKILL.md')
  return { version: typeof pkg.version === 'string' ? pkg.version : 'unknown', cliBin, skillDir, skillFile }
}

/**
 * Parse a `SKILL.md` file into its routing description and Markdown body.
 * @param {string} raw
 * @returns {{ description: string, body: string }}
 */
export function parseSkillMarkdown(raw) {
  const fallback = 'Find and run paid third-party tools through Solgrid (`solgrid` tool).'
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { description: fallback, body: raw }

  const frontmatter = match[1]
  const body = match[2]
  let description = ''
  const lines = frontmatter.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^description:\s*(.*)$/)
    if (!m) continue
    const rest = m[1].trim()
    if (rest && !/^[>|][-+]?$/.test(rest)) {
      description = rest.replace(/^['"]|['"]$/g, '')
    } else {
      /** @type {string[]} */
      const block = []
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[ \t]+/.test(lines[j])) block.push(lines[j].trim())
        else if (lines[j].trim() === '') block.push('')
        else break
      }
      description = block.join(' ').replace(/\s+/g, ' ').trim()
    }
    break
  }
  return { description: description || fallback, body }
}

/**
 * Return true when CLI arguments invoke the interactive `login` flow (excluding `--help`).
 * Handles global options such as `--lang zh login --json` or `--lang=zh login`.
 * @param {readonly string[]} args
 * @returns {boolean}
 */
export function isLoginCommand(args) {
  if (!Array.isArray(args) || args.length === 0) return false
  if (args.includes('--help') || args.includes('-h')) return false
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--lang') {
      i++ // skip the option value
      continue
    }
    if (token.startsWith('-')) continue
    return token === 'login'
  }
  return false
}

/**
 * Build the child process environment for the bundled CLI.
 * Config overrides take precedence over inherited process env; unset fields defer to CLI defaults.
 * @param {PluginConfig} config
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildCliEnv(config, baseEnv = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...baseEnv, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' }
  const apiBaseUrl = typeof config.apiBaseUrl === 'string' ? config.apiBaseUrl.trim() : ''
  if (apiBaseUrl) env.SOLGRID_API_BASE_URL = apiBaseUrl
  if (config.lang === 'en' || config.lang === 'zh') env.SOLGRID_LANG = config.lang
  return env
}

/**
 * Produce an AbortError compliant with the DSH `execute()` contract.
 * Propagates `signal.reason` when it is already an Error, else creates a DOMException named `AbortError`.
 * @param {AbortSignal | undefined} signal
 * @param {string} message
 * @returns {Error}
 */
export function createAbortError(signal, message) {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException(message, 'AbortError')
}

/**
 * @param {string} buf
 * @param {string} chunk
 * @param {number} limit
 * @returns {string}
 */
function appendLimited(buf, chunk, limit) {
  if (buf.length >= limit) return buf
  const next = buf + chunk
  return next.length > limit ? next.slice(0, limit) + '\n…[output truncated]' : next
}

/**
 * Gracefully terminate a child process with SIGTERM, escalating to SIGKILL after a short grace period.
 * @param {ChildProcess | undefined} child
 */
function terminateChild(child) {
  if (!child || child.killed || child.exitCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const killTimer = setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
  }, SIGKILL_GRACE_MS)
  killTimer.unref()
  child.once('exit', () => clearTimeout(killTimer))
}

/**
 * Internal factory used by `apply` and unit tests.
 * @param {Context} ctx
 * @param {PluginConfig} [config]
 * @param {ResolvedCli} [resolved]
 */
export function applyWithCli(ctx, config = {}, resolved = resolveSolgridCli()) {
  const { version, cliBin, skillDir, skillFile } = resolved
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const loginBannerTimeoutMs = config.loginBannerTimeoutMs ?? DEFAULT_LOGIN_BANNER_TIMEOUT_MS
  const maxOutputChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS

  const rawSkill = readFileSync(skillFile, 'utf8')
  const parsed = parseSkillMarkdown(rawSkill)

  ctx.skills.register({
    name: 'solgrid-cli',
    description: parsed.description,
    source: 'bundled',
    path: skillFile,
    resourceBase: { kind: 'directory', path: skillDir },
    content: DSH_SKILL_PREAMBLE + parsed.body,
  })

  /** @type {ChildProcess | undefined} */
  let activeLoginChild
  const stopActiveLogin = () => {
    terminateChild(activeLoginChild)
    activeLoginChild = undefined
  }
  ctx.effect(() => () => stopActiveLogin())

  /**
   * @param {string | undefined} requestedCwd
   * @param {{ agent?: { id: string }, signal: AbortSignal }} exec
   * @returns {Promise<string>}
   */
  const resolveCwd = async (requestedCwd, exec) => {
    if (requestedCwd) return requestedCwd
    const wd = ctx.get('workingDirectory')
    if (wd && exec.agent !== undefined) {
      try {
        return await wd.ensure(/** @type {any} */ (exec.agent), exec.signal)
      } catch {}
    }
    return process.cwd()
  }

  /**
   * @param {readonly string[]} cliArgs
   * @param {string} cwd
   * @param {number} timeoutMs
   * @param {AbortSignal} signal
   * @returns {Promise<CliRunResult>}
   */
  const runCli = (cliArgs, cwd, timeoutMs, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(createAbortError(signal, 'solgrid command aborted'))
        return
      }

      const child = spawn(process.execPath, [cliBin, ...cliArgs], {
        cwd,
        env: buildCliEnv(config),
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false

      /** @param {CliRunResult} result */
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      }

      /** @param {Error} err */
      const fail = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }

      const onAbort = () => {
        terminateChild(child)
        fail(createAbortError(signal, 'solgrid command aborted'))
      }

      signal.addEventListener('abort', onAbort, { once: true })

      const timer = setTimeout(() => {
        timedOut = true
        terminateChild(child)
      }, timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout = appendLimited(stdout, chunk, maxOutputChars)
      })
      child.stderr.on('data', (chunk) => {
        stderr = appendLimited(stderr, chunk, maxOutputChars)
      })
      child.on('error', (err) => fail(err))
      child.on('close', (code) => {
        finish({
          status: timedOut ? 'timeout' : code === 0 ? 'ok' : 'error',
          exitCode: code ?? 1,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
        })
      })
    })

  /**
   * Start `solgrid login` and return as soon as the device-code banner is written to stderr,
   * leaving the child process polling in the background until approval completes or plugin unload.
   * @param {readonly string[]} cliArgs
   * @param {string} cwd
   * @param {AbortSignal} signal
   * @returns {Promise<CliRunResult>}
   */
  const startLogin = (cliArgs, cwd, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(createAbortError(signal, 'solgrid login aborted'))
        return
      }

      stopActiveLogin()
      const child = spawn(process.execPath, [cliBin, ...cliArgs], {
        cwd,
        env: buildCliEnv(config),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      activeLoginChild = child

      let stdout = ''
      let stderr = ''
      let settled = false

      /** @param {CliRunResult} result */
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      }

      const onAbort = () => {
        stopActiveLogin()
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(createAbortError(signal, 'solgrid login aborted'))
        }
      }

      signal.addEventListener('abort', onAbort, { once: true })

      const timer = setTimeout(() => {
        finish({
          status: 'pending_approval',
          exitCode: 0,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
        })
      }, loginBannerTimeoutMs)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout = appendLimited(stdout, chunk, maxOutputChars)
      })
      child.stderr.on('data', (chunk) => {
        stderr = appendLimited(stderr, chunk, maxOutputChars)
        if (!settled && stderr.includes('The code expires in')) {
          finish({
            status: 'pending_approval',
            exitCode: 0,
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
          })
        }
      })
      child.on('error', (err) => {
        if (activeLoginChild === child) activeLoginChild = undefined
        if (!settled) {
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          reject(err)
        }
      })
      child.on('close', (code) => {
        if (activeLoginChild === child) activeLoginChild = undefined
        finish({
          status: code === 0 ? 'ok' : 'error',
          exitCode: code ?? 1,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
        })
      })
    })

  ctx.tools.register(
    defineTool({
      name: 'solgrid',
      description:
        `Run the bundled Solgrid CLI (v${version}) without requiring a global installation. ` +
        'Load the `solgrid-cli` skill first for the discover -> inspect -> run workflow, pricing rules, and safe retries. ' +
        'Always include `--json` in `args` for structured output.',
      parameters: {
        args: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description:
            'CLI arguments passed to `solgrid`, e.g. ["discover", "-q", "twitter user profile", "--json"] or ["whoami", "--json"].',
        },
        cwd: {
          type: 'string',
          description:
            'Optional working directory (defaults to the session workspace; used for relative file paths like `-o` or `files upload`).',
        },
        timeoutMs: {
          type: 'integer',
          description:
            `Optional positive timeout in milliseconds (defaults to ${defaultTimeoutMs}). Ignored for \`login\`, which returns the code immediately and polls in the background.`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            exitCode: { type: 'integer', required: true },
            stdout: { type: 'string', required: true },
            stderr: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          if (value.status === 'pending_approval') {
            const msg = [
              value.stderr || value.stdout,
              '',
              '[solgrid login is polling in the background. Relay the link and code above to the user. After they approve in the browser, run `whoami --json` or re-run the command that failed.]',
            ]
              .filter(Boolean)
              .join('\n')
            return [{ type: 'text', text: msg }]
          }
          const parts = []
          if (value.exitCode !== 0 || value.status !== 'ok') {
            parts.push(`[exit code: ${value.exitCode}, status: ${value.status}]`)
          }
          if (value.stdout) parts.push(value.stdout)
          if (value.stderr) parts.push(`stderr:\n${value.stderr}`)
          return [{ type: 'text', text: parts.join('\n') || '(no output)' }]
        },
      },
      async execute(args, exec) {
        if (args.args.length === 0) {
          throw new ToolArgsError([
            'args: must contain at least one CLI argument (for example ["discover", "-q", "twitter", "--json"])',
          ])
        }
        if (args.cwd !== undefined && args.cwd.trim() === '') {
          throw new ToolArgsError(['cwd: must be a non-empty directory path when provided'])
        }
        if (args.timeoutMs !== undefined && args.timeoutMs <= 0) {
          throw new ToolArgsError(['timeoutMs: must be a positive integer'])
        }

        const cwd = await resolveCwd(args.cwd, exec)
        if (isLoginCommand(args.args)) {
          return await startLogin(args.args, cwd, exec.signal)
        }
        const timeoutMs = args.timeoutMs ?? defaultTimeoutMs
        return await runCli(args.args, cwd, timeoutMs, exec.signal)
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `solgrid ${args.args.join(' ')}`.trim(),
        rawInput: args,
      }),
    }),
  )
}

/**
 * Cordis plugin entry point.
 * @param {Context} ctx
 * @param {PluginConfig} [config]
 */
export function apply(ctx, config = {}) {
  applyWithCli(ctx, config)
}
