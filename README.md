# Nekodex

Nekodex is a lightweight TypeScript agent CLI for working inside a local code
workspace. It is built around a Codex-style terminal UI, persistent sessions,
project instructions, memories, tool approvals, and OpenAI Responses models.

## Highlights

- Codex-like React/Ink TUI with transcript history, bottom composer, slash
  commands, model picker, approval prompts, and compact status line
- Auth with OpenAI API keys, ChatGPT browser login, or ChatGPT device-code login
- Workspace tools for listing files, reading files, writing files, text
  replacement, search, shell commands, and image generation
- Project and personal custom instructions from `AGENTS.md`, `SKILL.md`,
  `.nekodex/instructions.md`, Nekodex home, or `NEKODEX_INSTRUCTIONS`
- Persistent memories and chat sessions
- Automatic context-window compaction for long sessions
- Configurable model, reasoning effort, approval mode, sandbox mode, hosted
  OpenAI tools, and remote MCP servers
- Local stdio MCP server mode for exposing Nekodex workspace tools
- Linux, macOS, Windows, and Android Termux support

## Install

```bash
pnpm add -g @mewbleh/nekodex
```

For local development:

```bash
pnpm install
pnpm build
pnpm start
```

Nekodex requires Node.js 22 or newer.

## Login

Use an OpenAI API key:

```bash
nekodex auth login --api-key
```

Use a ChatGPT account in the browser:

```bash
nekodex auth login --chatgpt
```

Use device-code login when browser redirects are awkward, especially on SSH or
Termux:

```bash
nekodex auth login --device-code
```

Check or clear auth:

```bash
nekodex auth status
nekodex auth logout
```

## Start Chatting

Open the TUI in the current directory:

```bash
nekodex
```

Run a one-shot prompt:

```bash
nekodex -- "review the parser and add focused tests"
```

Use another workspace:

```bash
nekodex -C ../my-project
```

Use readline mode instead of the TUI:

```bash
nekodex --plain
```

## TUI Commands

Inside the TUI, type `/` to open command suggestions.

```text
/status          show auth, model, context, approval, sandbox, and instructions
/model           open the model picker
/model gpt-5.5   switch model immediately
/effort          open the reasoning-effort picker
/instructions    show loaded custom instruction files
/clear           clear the visible transcript
/help            show all slash commands
/exit            quit
```

Keyboard basics:

```text
Enter        send prompt or confirm a picker/approval
Esc          clear input, close overlays, or interrupt a running turn
Ctrl+C       interrupt a running turn; quit when idle
Tab          complete slash-command suggestions
Up/Down      move through slash suggestions and pickers
Left/Right   move the input cursor
```

## Custom Instructions

Nekodex loads instructions before every agent turn. Use them for project rules,
style preferences, verification commands, architecture notes, or reusable
workflow guidance.

Project-level files:

```text
AGENTS.md
AGENT.md
agent.md
agents.md
SKILL.md
skill.md
instructions.md
custom-instructions.md
.nekodex/AGENTS.md
.nekodex/AGENT.md
.nekodex/agent.md
.nekodex/SKILL.md
.nekodex/skill.md
.nekodex/instructions.md
.nekodex/custom-instructions.md
```

Personal files in the Nekodex config directory:

```text
instructions.md
custom-instructions.md
AGENTS.md
agent.md
```

You can also point to one or more files explicitly:

```bash
NEKODEX_INSTRUCTIONS=/path/to/personal.md nekodex
```

Use the initializer for a clean project starter:

```bash
nekodex init
```

Inside the TUI, run:

```text
/instructions
```

## Memories

Memories are persistent notes injected into future turns.

```bash
nekodex memory add --title "Project style" "Use strict TypeScript and pnpm."
nekodex memory list
nekodex memory search typescript
nekodex memory remove <id>
nekodex memory clear
```

## Model And Reasoning

Set defaults from the CLI:

```bash
nekodex config set model gpt-5.5
nekodex config set reasoningEffort medium
```

Override for one launch:

```bash
nekodex -m gpt-5.5 --effort high
```

Change inside the TUI:

```text
/model
/model gpt-5.4-mini
/effort
/effort high
```

## Tools And Approvals

By default, Nekodex asks before file writes and shell commands.

```bash
nekodex -y                         # approve automatically
nekodex --sandbox read-only        # inspect without writes
nekodex --sandbox workspace-write  # allow workspace writes
nekodex --danger-full-access       # allow outside-workspace access
```

Configure hosted OpenAI tools:

```bash
nekodex tools add-openai web_search
nekodex tools add-openai image_generation --partial-images 2
nekodex tools list
nekodex tools clear-openai
```

Generate images from the local agent tool by asking in chat, for example:

```text
create a 1024x1024 pixel-art icon for this CLI and save it in assets/
```

## MCP

Add remote MCP servers for Responses API tool use:

```bash
nekodex mcp add docs https://example.com/mcp --auth-env DOCS_MCP_TOKEN
nekodex mcp list
nekodex mcp clear
```

Run Nekodex as a local stdio MCP server:

```bash
nekodex mcp serve -C .
```

## Config

Inspect and edit local config:

```bash
nekodex config show
nekodex config set approvalMode ask
nekodex config set sandboxMode workspace-write
nekodex config set contextWindow.autoCompact true
nekodex config set contextWindow.compactThresholdTokens 200000
```

Override the config directory with:

```bash
NEKODEX_HOME=/path/to/config nekodex
```

## Platform Notes

Run diagnostics:

```bash
nekodex doctor
```

- Linux: install `xdg-utils` if browser login should auto-open.
- macOS: config defaults to `~/Library/Application Support/Nekodex`.
- Windows: config defaults to `%APPDATA%\Nekodex`.
- Termux: install `nodejs-lts`; device-code login is the most reliable auth
  flow.
