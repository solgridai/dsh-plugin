# @solgridai/dsh-plugin

English | [中文](README.zh.md)

Official [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) plugin bundle for [Solgrid](https://solgrid.ai).

It embeds [`@solgridai/cli`](https://www.npmjs.com/package/@solgridai/cli) and registers both the `solgrid-cli` skill and a `solgrid` tool, so Web and Desktop users can discover, inspect, and run Solgrid tools and SkillHub workflows out of the box — without installing the CLI globally or configuring Node.js.

## Install

### From the DSH Web / Desktop UI

1. Open **Plugins** in the sidebar.
2. Click **Add plugin**, enter the package name:
   ```text
   @solgridai/dsh-plugin
   ```
3. Click **Install** to confirm. The plugin activates immediately.

### From the DSH CLI

```sh
dsh plugin --profile web add @solgridai/dsh-plugin
```

Or install directly from GitHub (no build step required):

```sh
dsh plugin --profile web add github:solgridai/dsh-plugin
```

## Usage

Once enabled, ask your agent naturally:

- *"Use Solgrid to check my account balance."*
- *"Use Solgrid to find a tool for fetching a Twitter user profile and check its price."*
- *"Use Solgrid to generate an image of a cyberpunk cat at sunset and save it to `cat.png`."*

If you are not signed in yet, the agent automatically starts the device-code login flow (`solgrid login`), relays the browser authorization link and code without blocking, and resumes once you approve.

Credentials are stored in `~/.config/solgrid/cli/` and shared seamlessly with the standalone `solgrid` CLI.

## Configuration (optional)

By default, the plugin delegates API endpoint and language selection to `@solgridai/cli` (production `https://api.solgrid.ai`, English, overridable via `SOLGRID_API_BASE_URL` and `SOLGRID_LANG`).

You can also configure the plugin in your profile's `cordis.patch.yml`:

```yaml
- id: solgrid
  config:
    apiBaseUrl: https://api.solgrid.ai   # optional API base URL override
    lang: en                             # optional: "en" or "zh"
    defaultTimeoutMs: 300000             # optional safety-net subprocess timeout in ms (default: 300000)
    maxOutputChars: 200000               # optional stdout/stderr truncation cap (default: 200000)
```

Timeouts are layered so paid runs are never lost to a hard kill (via the bundled `@solgridai/cli` 0.7.0+ wrapper protocol):

- Every `run` reports its resolved idempotency key and wait budget on stderr before submitting — the plugin never modifies the arguments.
- The CLI prints `solgrid: {"idempotencyKey":"<key>","wait":<seconds>}` to stderr before submitting. stderr is not buffered by `--json` mode, so the line survives even a SIGKILL. The plugin reads it to align its timeout with the wait budget — the CLI's own `WAIT_TIMEOUT`, with run ID, key and recovery commands, is what the agent sees — and to name the exact key in a recovery hint when it must stop the CLI mid-run.
- `defaultTimeoutMs` / the tool's `timeoutMs` remain as a safety net against hung processes (downloads, network stalls).

## Development

```sh
npm install
npm run check      # TypeScript checkJs + node:test unit tests
```

To test a local checkout in DSH:

```sh
dsh plugin --profile web add .
```

## License

[MIT](LICENSE)
