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
import { randomUUID } from 'node:crypto'
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
/** Mirrors the CLI's own default for a bare `--wait` flag. */
const DEFAULT_WAIT_SECONDS = 300
/** Extra headroom above a declared `--wait` budget so the CLI's own WAIT_TIMEOUT fires first. */
const WAIT_GRACE_MS = 15_000
/** setTimeout() overflows above 2^31-1 ms (Node fires such timers after ~1ms); clamp well below. */
const MAX_TIMEOUT_MS = 2_147_483_000
/** Long options that require a value; commander consumes the next token unconditionally. */
const LONG_VALUE_OPTIONS = new Set([
  '--lang',
  '--input',
  '--input-file',
  '--query',
  '--path',
  '--provider',
  '--endpoint',
  '--output',
  '--skill',
  '--idempotency-key',
  '--run-id',
  '--limit',
  '--cursor',
])
/** Short options that take a value; `w` (`--wait`) is optional-valued, the rest required. */
const SHORT_VALUE_OPTIONS = new Set(['i', 'f', 'p', 'e', 'o', 'r', 'l', 'q', 'k', 's', 'w'])

/**
 * @param {string} token
 * @returns {boolean}
 */
function isOptionLike(token) {
  return token.length > 1 && token[0] === '-'
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isNegativeNumber(token) {
  return /^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/.test(token)
}

/**
 * Strip root-level (global) options the way the CLI's commander program parses them: `--lang <code>`
 * (its value is consumed unconditionally, even when option-like), `--lang=<code>`, and
 * `-v`/`--version` are extracted from anywhere until the `--` separator. At `--`, stripping stops
 * and the separator plus everything after it pass through verbatim — the subcommand scanner then
 * decides whether that `--` is an option's value (e.g. `run -o --`) or a real separator. Every kept
 * token carries its original index.
 * @param {readonly string[]} args
 * @returns {{ text: string, index: number }[]}
 */
export function localTokens(args) {
  /** @type {Array<{ text: string, index: number }>} */
  const tokens = []
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--') {
      for (let j = i; j < args.length; j++) tokens.push({ text: args[j], index: j })
      return tokens
    }
    if (token === '--lang') {
      i++ // commander consumes the next token unconditionally as the language code
      continue
    }
    if (token.startsWith('--lang=')) continue
    if (token === '--version' || token === '-v') continue
    tokens.push({ text: token, index: i })
  }
  return tokens
}

/**
 * Scan CLI arguments the way the CLI's commander setup parses them, yielding one occurrence per
 * tracked option: root-level global options are stripped first (see `localTokens`), then long
 * `--name value` / `--name=value`, short groups `-abc` where the first value-taking char consumes
 * the rest of the token as its raw value (no `=` stripping), two-token shorts, and the `--`
 * separator (yielded as name `'--'`, after which scanning stops). Every occurrence carries the
 * index of its option token in the original arguments. Repeated options yield repeatedly —
 * commander keeps the LAST assignment, so callers must too.
 * @param {readonly string[]} args
 * @yields {{ name: string, value: string | null, index: number }}
 */
export function* scanOptionOccurrences(args) {
  if (!Array.isArray(args)) return
  const tokens = localTokens(args)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].text
    const index = tokens[i].index
    if (token === '--') {
      yield { name: '--', value: null, index }
      return // everything after -- is an operand
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq !== -1) {
        yield { name: token.slice(0, eq), value: token.slice(eq + 1), index }
        continue
      }
      if (LONG_VALUE_OPTIONS.has(token)) {
        const next = tokens[i + 1] // commander consumes the next token unconditionally
        if (next !== undefined) i++
        yield { name: token, value: next !== undefined ? next.text : null, index }
      } else if (token === '--wait') {
        const next = tokens[i + 1]
        if (next !== undefined && (!isOptionLike(next.text) || isNegativeNumber(next.text))) {
          i++
          yield { name: token, value: next.text, index }
        } else {
          yield { name: token, value: null, index } // bare flag
        }
      } else {
        yield { name: token, value: null, index } // boolean flag
      }
      continue
    }
    if (isOptionLike(token)) {
      let rest = token.slice(1)
      while (rest !== '') {
        const char = rest[0]
        rest = rest.slice(1)
        if (!SHORT_VALUE_OPTIONS.has(char)) {
          yield { name: `-${char}`, value: null, index } // boolean (or unknown; the CLI will reject it)
          continue
        }
        if (rest !== '') {
          yield { name: `-${char}`, value: rest, index } // attached value, kept raw like commander
        } else {
          const next = tokens[i + 1]
          const takes =
            char === 'w'
              ? next !== undefined && (!isOptionLike(next.text) || isNegativeNumber(next.text))
              : next !== undefined
          if (takes) {
            i++
            yield { name: `-${char}`, value: next !== undefined ? next.text : null, index }
          } else {
            yield { name: `-${char}`, value: null, index }
          }
        }
        break // a value-taking char ends the group
      }
      continue
    }
    // operand (subcommand name or stray value): nothing to track
  }
}

/**
 * Return true when the arguments request help through an actual `--help`/`-h` option occurrence.
 * A `--help`/`-h` string that is merely another option's value (e.g. `run -o --help` uses it as
 * the output file name) does not count.
 * @param {readonly string[]} args
 * @returns {boolean}
 */
export function hasHelpRequest(args) {
  for (const occ of scanOptionOccurrences(args)) {
    if (occ.name === '--help' || occ.name === '-h') return true
  }
  return false
}

/**
 * Return the last occurrence of any of `names`, mirroring commander's last-wins assignment.
 * @param {readonly string[]} args
 * @param {readonly string[]} names
 * @returns {{ name: string, value: string | null } | undefined}
 */
function lastOption(args, names) {
  /** @type {{ name: string, value: string | null } | undefined} */
  let last
  for (const occ of scanOptionOccurrences(args)) {
    if (names.includes(occ.name)) last = occ
  }
  return last
}

const DSH_SKILL_PREAMBLE = `> **DeepSeek Harness (\`dsh\`) runtime note:** Use the built-in \`solgrid\` tool instead of running \`solgrid\` through \`bash\`. Pass CLI arguments as the \`args\` array (for example \`{ "args": ["discover", "-q", "twitter user profile", "--json"] }\`). The CLI is bundled with this plugin, so no separate installation is needed.
>
> For device-code login, call \`solgrid\` with \`{ "args": ["login", "--json"] }\`: it returns the authorization link and code immediately while polling in the background. Relay the link and code to the user; once they approve in their browser, run \`{ "args": ["whoami", "--json"] }\` or re-run the command that failed.
>
> Timeouts on paid runs: every \`run\` gets an \`--idempotency-key\` injected automatically, and the tool extends its own timeout to cover a declared \`--wait\` budget, so the CLI itself can report \`WAIT_TIMEOUT\` with the run ID and key. If the tool ever returns \`status: "timeout"\` for a \`run\`, its hint names the \`idempotencyKey\`: recover the result with \`{ "args": ["runs", "get", "--idempotency-key", "<key>", "--wait", "--json"] }\`, or re-run the same command with \`--idempotency-key <key>\`. Never resubmit with a fresh key — the original run may complete and be billed.
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
 * Return the subcommand token (the first positional) with its index, after global options are
 * stripped, e.g. `--lang zh run ...` resolves to `run` at its original position.
 * @param {readonly string[]} args
 * @returns {{ text: string, index: number } | undefined}
 */
export function subcommandPosition(args) {
  if (!Array.isArray(args)) return undefined
  for (const { text, index } of localTokens(args)) {
    if (!text.startsWith('-')) return { text, index }
  }
  return undefined
}

/**
 * Return the first positional token (the CLI subcommand), or undefined.
 * @param {readonly string[]} args
 * @returns {string | undefined}
 */
export function firstPositionalCommand(args) {
  return subcommandPosition(args)?.text
}

/**
 * Return true when CLI arguments invoke the interactive `login` flow (excluding help requests).
 * Handles global options such as `--lang zh login --json` or `--lang=zh login`.
 * @param {readonly string[]} args
 * @returns {boolean}
 */
export function isLoginCommand(args) {
  if (!Array.isArray(args) || args.length === 0) return false
  if (hasHelpRequest(args)) return false
  return firstPositionalCommand(args) === 'login'
}

/**
 * Return true when CLI arguments invoke the paid `run` command. No help exclusion: prepending a
 * key into `run --help` is harmless (help exits before any submission), while skipping a real
 * run on a misread help flag (e.g. `run -o --help`, where --help is a file name) would lose the
 * recovery key entirely.
 * @param {readonly string[]} args
 * @returns {boolean}
 */
export function isRunCommand(args) {
  if (!Array.isArray(args) || args.length === 0) return false
  return firstPositionalCommand(args) === 'run'
}

/**
 * Extract the effective `--wait` budget in seconds (last occurrence wins, like the CLI).
 * Handles `--wait 30`, `--wait=30`, `-w 30`, `-w30`, bare `--wait` (default 300) and combined short
 * groups like `-jw600`. Best-effort: a non-numeric value or an undetected spelling only lowers the
 * timeout floor — the injected idempotency key keeps the run recoverable either way.
 * @param {readonly string[]} args
 * @returns {number | undefined}
 */
export function extractWaitSeconds(args) {
  const occ = lastOption(args, ['--wait', '-w'])
  if (occ === undefined) return undefined
  if (occ.value === null) return DEFAULT_WAIT_SECONDS
  // Mirror the CLI's parsePositiveInt exactly: Number() conversion with an integer/positivity
  // check, so `600.0`, `6e2` or `0x254` are accepted precisely like the CLI accepts them.
  const parsed = Number(occ.value)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined
}

/**
 * Return true when the arguments contain an output-file option (`-o`/`--output`, including
 * attached forms like `-oout.json`), which implies `--wait`.
 * @param {readonly string[]} args
 * @returns {boolean}
 */
export function hasOutputOption(args) {
  return lastOption(args, ['-o', '--output']) !== undefined
}

/**
 * Prepare CLI arguments for execution: `run` commands get a freshly generated `--idempotency-key`
 * PREPENDED right after the subcommand name, unconditionally. The CLI resolves repeated keys by
 * last-wins, so an explicit key later in the command always overrides ours — "inject only when
 * absent" implemented by the CLI's own parser instead of a plugin-side reimplementation. An
 * explicit empty key likewise stays effective and is rejected with USAGE, exactly as without us.
 * Also reports the effective wait budget (declared, or implied by `-o`), best-effort.
 * @param {readonly string[]} args
 * @returns {{ cliArgs: readonly string[], idempotencyKey: string | undefined, waitSeconds: number | undefined }}
 */
export function prepareRunInvocation(args) {
  const waitSeconds = extractWaitSeconds(args)
  if (!isRunCommand(args)) {
    return { cliArgs: args, idempotencyKey: undefined, waitSeconds }
  }
  const idempotencyKey = randomUUID()
  const at = subcommandPosition(args)?.index ?? 0
  const cliArgs = [...args.slice(0, at + 1), '--idempotency-key', idempotencyKey, ...args.slice(at + 1)]
  const implied = hasOutputOption(args) ? DEFAULT_WAIT_SECONDS : undefined
  return { cliArgs, idempotencyKey, waitSeconds: waitSeconds ?? implied }
}

/**
 * Compute the effective subprocess timeout: never below the requested value, but extended to cover a
 * declared `--wait` budget plus a grace margin, so the CLI's own WAIT_TIMEOUT (with run ID, key and
 * recovery hints) is returned instead of a hard kill. Clamped below the setTimeout overflow limit.
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
 * mirroring the CLI's own error contract (idempotency key, run ID, follow-up commands). The key
 * is the one this tool prepended; when the command carried its own --idempotency-key, that key
 * (its last occurrence) is the effective one and the notice says so.
 * @param {{ timeoutMs: number, idempotencyKey: string | undefined, runId?: string | undefined }} info
 * @returns {string | undefined}
 */
export function buildTimeoutNotice({ timeoutMs, idempotencyKey, runId }) {
  if (idempotencyKey === undefined && runId === undefined) return undefined
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  /** @type {string[]} */
  const lines = [
    `WAIT_TIMEOUT: the solgrid tool stopped the CLI after ~${seconds}s, before it could report the outcome.`,
    'The run may still be running (or already finished) on Solgrid and may be billed. Do not resubmit a modified command.',
  ]
  if (runId !== undefined) {
    lines.push(`runId: ${runId}`, `Check it with: solgrid runs get -r ${runId} --wait --json`)
  }
  if (idempotencyKey !== undefined) {
    lines.push(
      `idempotencyKey: ${idempotencyKey} (auto-injected by this tool)`,
      `Check it with: solgrid runs get --idempotency-key ${idempotencyKey} --wait --json`,
      'If the command passed its own --idempotency-key, its last occurrence is the effective key — use that one instead.',
      'A NOT_FOUND answer means nothing was accepted; re-running the identical command is then safe.',
    )
  }
  return lines.join('\n')
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
   * @param {string} [idempotencyKey] present when the invocation is a paid `run`; enables the WAIT_TIMEOUT recovery notice
   * @returns {Promise<CliRunResult>}
   */
  const runCli = (cliArgs, cwd, timeoutMs, signal, idempotencyKey) =>
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
        const hint =
          timedOut && idempotencyKey !== undefined
            ? buildTimeoutNotice({ timeoutMs, idempotencyKey, runId: extractRunId(stdout) })
            : undefined
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
            `Optional positive timeout in milliseconds (defaults to ${defaultTimeoutMs}). Treated as a lower bound for ` +
            'commands with `--wait <seconds>`: the effective timeout is extended to cover the wait plus a margin, ' +
            'so the CLI can return its own WAIT_TIMEOUT with the run ID and idempotency key. Ignored for `login`, ' +
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
        const { cliArgs, idempotencyKey, waitSeconds } = prepareRunInvocation(args.args)
        const timeoutMs = resolveTimeoutMs(args.timeoutMs ?? defaultTimeoutMs, waitSeconds)
        return await runCli(cliArgs, cwd, timeoutMs, exec.signal, idempotencyKey)
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
