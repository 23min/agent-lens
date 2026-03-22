# Agent Lens

[![CI](https://github.com/23min/agent-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/23min/agent-lens/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/Proliminal.agent-lens)](https://marketplace.visualstudio.com/items?itemName=Proliminal.agent-lens)

**Understand what your AI coding agents are actually doing.**

Agent Lens gives you visibility into your GitHub Copilot, Claude Code, and OpenAI Codex CLI sessions — which agents ran, what models they used, how many tokens they consumed, and how your agent workflows connect.

![Metrics Dashboard](assets/screenshots/donuts.png)

![Session Timeline](assets/screenshots/session-timeline.png)

## Why Agent Lens?

AI coding agents are powerful but opaque. When you use custom agents in GitHub Copilot or sub-agents in Claude Code, it's hard to know:

- Which agents are doing the most work?
- How are tokens distributed across models?
- Are your custom agents and skills actually being used?
- How do your agents hand off work to each other?

Agent Lens answers these questions by parsing your local session data and presenting it visually — right inside VS Code.

## Features

### Metrics Dashboard

See token usage, model distribution, agent activity, tool calls, and skill usage at a glance. Filter by provider (Copilot, Claude, Codex, or all), narrow by time scope (All time, Today, Last hour), or drill into a single session with the session picker. Spot unused agents and skills that might need attention.

### Agent & Skill Explorer

Browse your agents and skills in the sidebar. See their tools, models, and handoff chains. Click to open the source file.

### Agent Graph

Interactive DAG visualization of your agents, skills, and handoff connections. Zoom, pan, and hover for details.

### Session Explorer

Replay individual sessions as a timeline. See each request's agent, model, tokens, tool calls, and timing. Spot agent switches and model changes. Sessions that used a custom agent or Copilot skills show compact badges at a glance. Browse sessions across all your projects or filter to just the current workspace.

### Cache Token Metrics

For Claude Code sessions: see cache read tokens, cache creation tokens, cache hit ratio, and an input token breakdown showing cached vs non-cached input.

## Supported AI Tools

| Tool | What Agent Lens reads |
|------|----------------------|
| **GitHub Copilot** | Chat session JSONL files from VS Code workspace storage. Detects custom agents (from `.github/agents/`) and skills (from `.github/skills/`). |
| **Claude Code** | Session JSONL files from `~/.claude/projects/`. Detects custom agents and skills, parses sub-agent sessions and prompt caching metrics. |
| **OpenAI Codex CLI** | Rollout JSONL files from `~/.codex/sessions/`. Parses turn-level token usage with cumulative delta computation, tool calls, and model tracking. |

Session data stays local — Agent Lens only reads files already on your machine.

## Getting Started

1. Install Agent Lens from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Proliminal.agent-lens)
2. Open a project where you've used GitHub Copilot or Claude Code
3. Look for the **Agent Lens** icon in the activity bar
4. Click **Show Metrics Dashboard** or **Session Explorer** to explore your sessions

Agent Lens automatically discovers sessions across **all your projects** by default. No configuration needed in most cases.

### Devcontainers & Remote SSH

If your sessions live on a mounted host path, configure the directory manually:

| Setting | Description |
|---------|-------------|
| `agentLens.sessionDir` | Path to Copilot chat session files (or a `workspaceStorage` root) |
| `agentLens.claudeDir` | Path to Claude Code project files (e.g., a mounted `~/.claude/projects`) |
| `agentLens.codexDir` | Path to Codex CLI sessions directory (e.g., a mounted `~/.codex/sessions`) |
| `agentLens.discoverAllProjects` | Discover sessions from all projects (default: `true`). Disable to show only current workspace sessions. |

Use the **Agent Lens: Container Setup Guide** command for step-by-step instructions.

For a detailed breakdown of what Agent Lens can and cannot see in each environment — including how agent and skill detection works, common pitfalls, and data freshness — see the [session discovery guide](docs/session-discovery.md).

## Contributing

Found a bug or have an idea? Open an [issue](https://github.com/23min/agent-lens/issues) or submit a pull request.

## License

[MIT](LICENSE)
