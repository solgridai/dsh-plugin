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
