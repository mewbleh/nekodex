# Nekodex

Nekodex is a lightweight TypeScript agent CLI inspired by Codex. It supports:

- OpenAI API-key auth
- ChatGPT browser login with PKCE
- ChatGPT device-code login
- Terminal UI with `nekodex tui`
- Persistent memories with `nekodex memory`
- `AGENTS.md`, `AGENT.md`, and `SKILL.md` instruction loading
- OpenAI-hosted Responses tools via config
- OpenAI image generation as both a local workspace tool and hosted tool config
- Remote MCP tool configuration for OpenAI Responses
- Local stdio MCP server with `nekodex mcp serve`
- Automatic context-window compaction
- An OpenAI Responses API agent loop
- Workspace tools for file reads, writes, exact search, exact replacement, and shell commands
- Local config in `~/.nekodex`

## Quick Start

```bash
pnpm add -g @mewbleh/nekodex
nekodex auth login --api-key
nekodex -- "inspect this project and suggest next steps"
```

For local development:

```bash
pnpm install
pnpm build
pnpm start auth login --api-key
pnpm start -- "inspect this project and suggest next steps"
```

For ChatGPT login:

```bash
pnpm start auth login --chatgpt
pnpm start auth login --device-code
```

Useful options:

```bash
nekodex -C ./some-project -m gpt-5 -- "add tests for the parser"
nekodex -y -- "run the test suite and fix failures"
nekodex tui
nekodex memory add --title "Project style" "Use strict TypeScript."
nekodex tools add-openai web_search
nekodex tools add-openai image_generation --partial-images 2
nekodex mcp add docs https://example.com/mcp --auth-env DOCS_MCP_TOKEN
nekodex mcp serve -C .
nekodex config set contextWindow.autoCompact true
nekodex config set contextWindow.compactThresholdTokens 200000
nekodex config set approvalMode auto
nekodex config show
```

## Publishing

The repo package name is `nekodex`; the GitHub Actions publish job rewrites the
npm package name to `@mewbleh/nekodex` immediately before publishing. It publishes
tagged releases or manual dispatches when `NPM_TOKEN` is configured in repository
secrets.
