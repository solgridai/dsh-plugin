# Solgrid

Discover and run paid third-party tools and hosted creative skills from [Solgrid](https://solgrid.ai) directly inside DeepSeek Harness — with no separate CLI or Node.js setup required.

## What you can do

- **Social media & structured data** — look up profiles, posts, and search results across Twitter/X, Instagram, LinkedIn, and more.
- **Image, video & audio generation** — generate and transform media, upload local files securely, and save outputs to your workspace.
- **SkillHub** — browse, download, and run community creative workflows.

## Getting started

No manual API key setup is needed. Just start a conversation and ask DeepSeek Harness to use Solgrid:

> "Use Solgrid to find a tool for fetching a Twitter user profile and check its price."
>
> "Generate a cyberpunk cat at sunset with Solgrid and save the image as `cat.png`."
>
> "Show the top 5 trending skills on Solgrid SkillHub."

On your first use, the agent will display a Solgrid authorization link and short code. Open the link in your browser, approve the login, and the agent will automatically store the key locally and continue your task — your API key never passes through the chat.

## Pricing & privacy

- Discovering tools, inspecting schemas/prices, and browsing SkillHub are free.
- Running paid tools charges your [Solgrid](https://solgrid.ai) wallet in **Spark** (1 USD = 100 Spark). The agent checks pricing before running expensive tools.
- Uploaded local files are private and accessed through temporary signed URLs (valid for 24 hours).
- Credentials are stored locally under `~/.config/solgrid/cli/` and shared with the standalone `solgrid` CLI if you also use it in your terminal.

## Timeouts & billing safety

Paid runs keep running (and get billed) on Solgrid even if the local CLI is stopped, so the plugin never lets a timeout silently lose track of one:

- A declared `--wait <seconds>` budget (or the wait implied by `-o`) always wins over the tool timeout: the effective limit is extended to the wait plus a grace margin, and the CLI itself returns a `WAIT_TIMEOUT` error naming the run ID, the idempotency key and the follow-up command.
- Every `run` receives an auto-injected `--idempotency-key`, so even a residual hard timeout returns a recovery hint. Follow it with `runs get --idempotency-key <key> --wait` to fetch the finished run, or re-run the same command with that key — Solgrid returns the existing run instead of charging a second one.
- The remaining timeout (`defaultTimeoutMs`, `timeoutMs`) is a safety net against hung processes such as long downloads, not a deadline for in-flight runs.
