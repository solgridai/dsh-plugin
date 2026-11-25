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
/** Extra headroom above a CLI-reported wait budget so the CLI's own WAIT_TIMEOUT fires first. */
const WAIT_GRACE_MS = 15_000
/** setTimeout() overflows above 2^31-1 ms (Node fires such timers after ~1ms); clamp well below. */
const MAX_TIMEOUT_MS = 2_147_483_000

/**
 * Parse the CLI's stderr report line — `solgrid: {"idempotencyKey":"<key>","wait":<seconds>}` —
 * written by `run` and `runs get --wait` before any network I/O. The payload is JSON, so keys
 * with spaces, `=` or even newlines are carried losslessly; stderr is not buffered by `--json`,
 * so the line survives a SIGKILL at any point, carrying the CLI's own resolved key and wait
 * budget.
 * @param {string} text accumulated stderr text
 * @returns {{ idempotencyKey: string | undefined, waitSeconds: number | undefined } | undefined}
 */
export function parseRunReport(text) {
  if (!text) return undefined
  const line = text.match(/^solgrid: (\{[^\r\n]*\})/m)?.[1]
  if (line === undefined) return undefined
  try {
    const report = JSON.parse(line)
    if (report === null || typeof report !== 'object' || Array.isArray(report)) return undefined
    const idempotencyKey =
      typeof report.idempotencyKey === 'string' && report.idempotencyKey !== ''
        ? report.idempotencyKey
        : undefined
    const waitSeconds = typeof report.wait === 'number' && report.wait >= 1 ? report.wait : undefined
    if (idempotencyKey === undefined && waitSeconds === undefined) return undefined
    return { idempotencyKey, waitSeconds }
  } catch {
    return undefined
  }
}

const DSH_SKILL_PREAMBLE = `> **DeepSeek Harness (\`dsh\`) runtime note:** Use the built-in \`solgrid\` tool instead of running \`solgrid\` through \`bash\`. Pass CLI arguments as the \`args\` array (for example \`{ "args": ["discover", "-q", "twitter user profile", "--json"] }\`). The CLI is bundled with this plugin, so no separate installation is needed.
>
> For device-code login, call \`solgrid\` with \`{ "args": ["login", "--json"] }\`: it returns the authorization link and code immediately while polling in the background. Relay the link and code to the user; once they approve in their browser, run \`{ "args": ["whoami", "--json"] }\` or re-run the command that failed.
>
> Timeouts on paid runs: before submitting, the CLI reports \`solgrid: {"idempotencyKey":"<key>","wait":<seconds>}\` on stderr, so this tool aligns its timeout with the wait budget. If the tool ever returns \`status: "timeout"\` for a \`run\`, its hint names the effective \`idempotencyKey\`: recover the result with \`{ "args": ["runs", "get", "--idempotency-key", "<key>", "--wait", "--json"] }\`, or re-run the same command with \`--idempotency-key <key>\`. Never resubmit with a fresh key — the original run may complete and be billed.
>
> To upgrade, update \`@solgridai/dsh-plugin\` from DSH **Plugins** rather than running \`npm install -g @solgridai/cli\`.

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
 * @property {string} [hint] WAIT_TIMEOUT-style recovery notice attached when a run is cut off by the tool timeout.
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
    .description(
      'Safety-net subprocess timeout in milliseconds (default: 300000). Commands declaring `--wait <seconds>` ' +
        'automatically get at least that long plus a grace margin, so the CLI reports its own WAIT_TIMEOUT first.',
    ),
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
 * Return the first positional token (the CLI subcommand), skipping root-level global options
 * (`--lang <code>`, `--lang=<code>`, `-v`, `--version`) that may precede it.
 * @param {readonly string[]} args
 * @returns {string | undefined}
 */
export function firstPositionalCommand(args) {
  if (!Array.isArray(args)) return undefined
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--lang') {
      i++ // skip the option value
      continue
    }
    if (token.startsWith('--lang=')) continue
    if (token === '--version' || token === '-v') continue
    if (token.startsWith('-')) continue
    return token
  }
  return undefined
}

/**
 * Return true when CLI arguments invoke the interactive `login` flow. Handles global options
 * such as `--lang zh login --json` or `--lang=zh login`. A `login --help` routed here is
 * harmless: the CLI prints its help and exits immediately.
 * @param {readonly string[]} args
 * @returns {boolean}
 */
export function isLoginCommand(args) {
  if (!Array.isArray(args) || args.length === 0) return false
  return firstPositionalCommand(args) === 'login'
}

/**
 * Return true when CLI arguments invoke the paid `run` command — the only one that reports
 * its idempotency key on stderr. `run --help` counts too: help exits before any submission.
 * @param {readonly string[]} args
 * @returns {boolean}
 */
export function isRunCommand(args) {
  if (!Array.isArray(args) || args.length === 0) return false
  return firstPositionalCommand(args) === 'run'
}

/**
 * Compute the effective subprocess timeout: never below the requested value, but extended to
 * cover a reported wait budget plus a grace margin, so the CLI's own WAIT_TIMEOUT (with run ID,
 * key and recovery hints) fires instead of a hard kill. Clamped below the setTimeout overflow
 * limit.
 * @param {number} requestedMs
 * @param {number | undefined} waitSeconds
 * @returns {number}
 */
export function resolveTimeoutMs(requestedMs, waitSeconds) {
  if (waitSeconds === undefined) return Math.min(requestedMs, MAX_TIMEOUT_MS)
  return Math.min(Math.max(requestedMs, waitSeconds * 1000 + WAIT_GRACE_MS), MAX_TIMEOUT_MS)
}

/**
 * Best-effort extraction of a run ID from partial CLI output (JSON `"runId"` field or text-mode `Run ID:` line).
 * @param {string} output
 * @returns {string | undefined}
 */
export function extractRunId(output) {
  if (!output) return undefined
  const json = output.match(/"runId"\s*:\s*"([^"]+)"/)
  if (json) return json[1]
  const text = output.match(/Run ID:?\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return text ? text[1] : undefined
}

/**
 * Build a WAIT_TIMEOUT-style recovery notice for a `run` cut off by the tool-level timeout,
 * mirroring the CLI's own error contract. `idempotencyKey` is the key the CLI itself reported
 * on stderr before any network I/O — the exact one it resolved from flag or generation.
 * @param {{ timeoutMs: number, idempotencyKey: string, runId?: string | undefined }} info
 * @returns {string}
 */
export function buildTimeoutNotice({ timeoutMs, idempotencyKey, runId }) {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  /** @type {string[]} */
  const lines = [
    `WAIT_TIMEOUT: the solgrid tool stopped the CLI after ~${seconds}s, before it could report the outcome.`,
    'The run may still be running (or already finished) on Solgrid and may be billed. Do not resubmit a modified command.',
  ]
  if (runId !== undefined) {
    lines.push(`runId: ${runId}`, `Check it with: solgrid runs get -r ${runId} --wait --json`)
  }
  lines.push(
    `idempotencyKey: ${idempotencyKey}`,
    `Check it with: solgrid runs get --idempotency-key ${idempotencyKey} --wait --json`,
  )
  return lines.join('\n')
}

/**
 * Build the recovery notice for a `run` killed before the CLI reported its idempotency key.
 * The CLI writes the report line before any network I/O, so no line means nothing was
 * submitted: re-running the identical command is safe — no key needed, nothing to lose.
 * @param {number} timeoutMs
 * @returns {string}
 */
export function buildNotReportedNotice(timeoutMs) {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  return [
    `WAIT_TIMEOUT: the solgrid tool stopped the CLI after ~${seconds}s, before it reported its idempotency key.`,
    'The CLI reports the key before submitting anything, so no run was started; re-running the identical command is safe.',
  ].join('\n')
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
  const env = {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
    NO_COLOR: '1',
    SOLGRID_NO_UPDATE_CHECK: baseEnv.SOLGRID_NO_UPDATE_CHECK ?? '1',
  }
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
   * @param {NodeJS.ProcessEnv} [env]
   * @param {boolean} [isRun] true for paid `run` invocations; enables the recovery notices
   * @returns {Promise<CliRunResult>}
   */
  const runCli = (cliArgs, cwd, timeoutMs, signal, env, isRun) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(createAbortError(signal, 'solgrid command aborted'))
        return
      }

      const child = spawn(process.execPath, [cliBin, ...cliArgs], {
        cwd,
        env: env ?? buildCliEnv(config),
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      /** The idempotency key the CLI reported on stderr — its own resolved, exact one. */
      /** @type {string | undefined} */
      let reportedKey
      /** The effective timeout right now; the re-armed value is the one the notice reports. */
      let currentTimeoutMs = timeoutMs

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

      const onTimeout = () => {
        timedOut = true
        terminateChild(child)
      }
      /** @type {ReturnType<typeof setTimeout>} */
      let timer = setTimeout(onTimeout, currentTimeoutMs)

      /**
       * The CLI reports `solgrid: {"idempotencyKey":"<key>","wait":<seconds>}` on stderr before any
       * network I/O. On arrival: remember the exact effective key, and realign the safety net
       * with the reported wait budget (only ever extending it) so the CLI's own WAIT_TIMEOUT —
       * run ID, key and recovery hints included — is what the agent sees, not a hard kill.
       * @param {string} text accumulated stderr
       */
      const onStderr = (text) => {
        const report = parseRunReport(text)
        if (report === undefined) return
        if (report.idempotencyKey !== undefined) reportedKey = report.idempotencyKey
        if (report.waitSeconds !== undefined && !timedOut) {
          const next = resolveTimeoutMs(timeoutMs, report.waitSeconds)
          if (next > currentTimeoutMs) {
            currentTimeoutMs = next
            clearTimeout(timer)
            timer = setTimeout(onTimeout, currentTimeoutMs)
          }
        }
      }

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout = appendLimited(stdout, chunk, maxOutputChars)
      })
      child.stderr.on('data', (chunk) => {
        stderr = appendLimited(stderr, chunk, maxOutputChars)
        onStderr(stderr)
      })
      child.on('error', (err) => fail(err))
      child.on('close', (code) => {
        /** @type {string | undefined} */
        let hint
        if (timedOut && isRun) {
          hint =
            reportedKey !== undefined
              ? buildTimeoutNotice({
                  timeoutMs: currentTimeoutMs,
                  idempotencyKey: reportedKey,
                  runId: extractRunId(stdout),
                })
              : buildNotReportedNotice(currentTimeoutMs)
        }
        finish({
          status: timedOut ? 'timeout' : code === 0 ? 'ok' : 'error',
          exitCode: code ?? 1,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          ...(hint !== undefined ? { hint } : {}),
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
            `Optional positive timeout in milliseconds (defaults to ${defaultTimeoutMs}); a hang safety net. ` +
            'Commands that wait (run/runs get with --wait, or -o) report their wait budget on stderr, and this ' +
            'timeout is extended to cover it, so the CLI reports its own WAIT_TIMEOUT first. Ignored for `login`, ' +
            'which returns the code immediately and polls in the background.',
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
            hint: {
              type: 'string',
              description:
                'Recovery notice present when a paid `run` was cut off by the tool timeout: names the idempotency key (and run ID when known) with follow-up commands.',
            },
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
          if (value.hint) parts.push(value.hint)
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
        const isRun = isRunCommand(args.args)
        const timeoutMs = args.timeoutMs ?? defaultTimeoutMs
        return await runCli(args.args, cwd, timeoutMs, exec.signal, buildCliEnv(config), isRun)
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
