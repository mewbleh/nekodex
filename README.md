# Nekodex

Nekodex is a lightweight TypeScript agent CLI inspired by Codex. It supports:

- OpenAI API-key auth
- ChatGPT browser login with PKCE
- ChatGPT device-code login
- `gpt-5.5` default model, with ChatGPT-backend remapping for retired Codex model names
- React/Ink terminal UI with `nekodex tui`
- Persistent memories with `nekodex memory`
- `AGENTS.md`, `AGENT.md`, and `SKILL.md` instruction loading
- OpenAI-hosted Responses tools via config
- OpenAI image generation as both a local workspace tool and hosted tool config
- Remote MCP tool configuration for OpenAI Responses
- Local stdio MCP server with `nekodex mcp serve`
- Automatic context-window compaction
- Lightweight sandbox modes: `read-only`, `workspace-write`, and `danger-full-access`
- An OpenAI Responses API agent loop
- Workspace tools for file reads, writes, exact search, exact replacement, and shell commands
- Platform-aware local config storage

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

ChatGPT login uses allowed ChatGPT OAuth scopes. Nekodex first tries the optional
OpenAI API-token exchange; if the account cannot mint that token, it falls back
to the ChatGPT Codex backend auth path used by Codex. If an older Nekodex build
sent you to an `invalid_scope` callback for `api.responses.write`, upgrade and
retry login:

```bash
nekodex auth logout
nekodex auth login --chatgpt
```

When using ChatGPT backend auth, old stored defaults like `gpt-5` are remapped to
`gpt-5.5` because the Codex backend no longer accepts the general `gpt-5` model
name for ChatGPT accounts.

Useful options:

```bash
nekodex -C ./some-project -m gpt-5.5 -- "add tests for the parser"
nekodex -y -- "run the test suite and fix failures"
nekodex --sandbox read-only -- "review this repo without changing files"
nekodex --danger-full-access -- "inspect a project that needs outside-workspace access"
nekodex tui
nekodex memory add --title "Project style" "Use strict TypeScript."
nekodex tools add-openai web_search
nekodex tools add-openai image_generation --partial-images 2
nekodex mcp add docs https://example.com/mcp --auth-env DOCS_MCP_TOKEN
nekodex mcp serve -C .
nekodex config set contextWindow.autoCompact true
nekodex config set contextWindow.compactThresholdTokens 200000
nekodex config set approvalMode auto
nekodex config set sandboxMode workspace-write
nekodex config show
```

## Platform Support

Nekodex runs on Node.js 22+ across Linux, Windows, macOS, and Android through
Termux. Use `nekodex doctor` to inspect platform detection, config paths, and
browser-login helpers.

- Linux: install `xdg-utils` if browser login should auto-open.
- Windows: config lives under `%APPDATA%\Nekodex` by default.
- macOS: config lives under `~/Library/Application Support/Nekodex` by default.
- Termux: install with `pkg install nodejs-lts`, then use device-code auth or
  install `termux-api` for `termux-open-url` browser opening.

Override the config directory anywhere with `NEKODEX_HOME`.

## Publishing

The repo package name is `nekodex`; the GitHub Actions publish job rewrites the
npm package name to `@mewbleh/nekodex` immediately before publishing. It publishes
tagged releases or manual dispatches when `NPM_TOKEN` is configured in repository
secrets.
