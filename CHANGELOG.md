# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Cross-project session discovery: browse sessions from **all** Claude and Copilot projects — not just the current workspace. Sessions grouped by project name with "(current)" marker for the active workspace.
- `agentLens.discoverAllProjects` setting (default: `true`) — toggle between all-projects and current-workspace-only discovery
- Session Explorer: scope toggle to switch between "All Projects" and "Current Project" views
- Session Explorer: project name badges and grouped section headers when viewing all projects
- Claude locator: `decodeProjectName()` extracts human-readable project names from encoded directory paths
- Claude locator: `discoverAllClaudeProjects()` scans all subdirectories in `~/.claude/projects/`
- Copilot provider: `scanAllWorkspaceStorageDirs()` scans all workspace storage hash directories for global discovery

### Fixed
- Extension host crash (`UNRESPONSIVE extension host`) on large Copilot session files (e.g. 75 MB). Two-part fix: (1) session files larger than 15 MB are now skipped with a debug log entry, preventing the event loop from being blocked by monster files; (2) `parseSessionJsonl` and `parseClaudeSessionJsonl` are now async and yield the event loop every 500 lines, preventing medium-sized files from blocking for multiple seconds.
- Session Explorer empty on first open — webview now signals readiness before data is pushed, fixing a race condition
- Double scope filtering with inconsistent logic — scope filter now applied server-side only with strict `=== true` check
- Claude session cache: subagent file changes now invalidate the cache (previously only main session file mtime was checked)
- Global mode: custom `claudeDir` is now watched for changes (previously only `~/.claude/projects/` was watched)
- `discoverAllProjects` setting description narrowed to reflect that Codex sessions are always discovered

## [0.1.1] - 2026-03-02

### Fixed
- Session Timeline: case-insensitive custom agent name matching — Copilot agents from `.github/agents/` now correctly render in teal regardless of filename casing (Fixes #61)

### Added
- Session Timeline: MCP mini-bars — small blue bars stacked below each request bar showing the count and proportion of MCP tool calls, with per-bar tooltip (agent, MCP call count, total tokens) and legend entry (Fixes #61)

## [0.1.0] - 2026-03-01

### Added
- Session Timeline: horizontal bar chart in Session Explorer showing requests as proportional bars across agent swimlanes, with sticky header and minimap scrollbar
- Session Timeline: vertical connector lines linking parent requests to spawned subagent bars, with click-to-scroll navigation
- Session Timeline: color-coded legend — custom agents (from `.claude/agents/`, `.github/agents/`) in teal, built-in agents in amber, compact requests in coral
- Session Timeline: dynamic custom agent detection from filesystem (no hardcoded agent names)
- Session Timeline: day separator lines with date labels for multi-day sessions
- Session Timeline: hover tooltip showing agent name, model, timing, token counts (including cache creation and cache read tokens)
- Parser: subagent parent linking via `buildSubagentMaps` single-pass JSONL scan (replaces separate type/parent map functions)
- Tests: 10 new tests for timeline format helpers (`formatTokens`, `formatCacheTokens`, `formatTime`)
- CLAUDE.md: agent delegation section instructing Claude Code to use custom agents for implementation, review, research, planning, and release tasks
- README: session timeline screenshot

### Fixed
- Session Timeline: correct custom vs built-in agent color mapping (custom agents from `.claude/agents/` now consistently teal)
- Session Timeline: SVG label clipping at chart bottom boundary
- Session Timeline: tooltip clamped within viewport on short charts
- Session Timeline: token-proportional bar widths (replacing gap-based sizing)
- Parser: system tag filtering now checks specific prefixes (`<ide_`, `<system-`, `<command-`, `<environment_`) instead of all `<`-prefixed text

## [0.0.19] - 2026-02-28

### Fixed
- Metrics Dashboard: built-in Claude Code subagent types (Explore, Plan, general-purpose, Bash, compact) are no longer highlighted as custom agents (closes #56)
- Session Explorer: Claude sessions now show the first user message as the title instead of raw session GUIDs; system-injected tags (`<ide_opened_file>`, etc.) are filtered out (closes #58)
- Metrics Dashboard: skills preloaded via agent `skills:` frontmatter field are now detected from `<skill-format>` markers in subagent JSONL (closes #57)
- Parser: `buildSubagentTypeMap` now recognises both `Task` and `Agent` tool names, fixing subagent type resolution for recent Claude Code versions (closes #54)

## [0.0.18] - 2026-02-21

### Changed
- Agent Graph: replaced manual longest-path layout with d3-dag Sugiyama algorithm for proper crossing reduction, optimal layer assignment, and smooth coordinate placement (closes #21)
- Agent Graph: redesigned node visuals — smaller solid-fill dots with outer ring, labels to the right, vibrant color palette
- Agent Graph: edge routing now uses d3-dag control points with smooth cubic basis curves instead of hand-computed bezier offsets
- Agent Graph: graphs with cycles are handled via DFS back-edge detection; reversed edges render as dashed lines
- Tree view categories start collapsed on first load instead of expanded

### Added
- Agent Graph: legend overlay showing node types and edge styles
- `webview/layout.ts`: extracted graph layout into a dedicated module with cycle-breaking and d3-dag integration
- `webview/layout.test.ts`: 15 unit tests for layout and cycle-breaking logic

## [0.0.17] - 2026-02-19

### Added
- Metrics Dashboard: time-scope toggle — filter metrics to All time, Today, or Last hour based on most recent request activity per session (closes #40)
- Metrics Dashboard: session picker — select a specific session to scope all metrics to that one session; provider and time-scope toggles dim automatically when a session is selected (closes #40)
- Session Explorer: custom agent badge — shows the agent name (or count) when any request in a session used a custom agent (closes #42)
- Session Explorer: Copilot skills badge — shows the number of Copilot skills available when a session had skills injected into its system prompt (closes #42)

### Fixed
- Suppressed frequent "Found N Copilot Chat session(s) from a previous workspace hash" info notification; stale-hash session recovery now logs silently at debug level (closes #41)

### Changed
- Debug extension host launch config now opens the workspace folder automatically, preventing the window-reload debugger disconnect

## [0.0.16] - 2026-02-18

### Added
- Multi-source Copilot session discovery: strategy 4 probes the platform-native VS Code storage root (macOS, Linux, Windows) for sessions that live outside the workspace hash or remote-SSH paths (closes #37)
- `sessionDir` config is now additive — complements rather than overrides automatic discovery, so sessions from all sources are merged and deduplicated
- Custom agent highlighting in Metrics Dashboard: custom agents (from `.github/agents/`) appear in teal with a `(custom agent)` tooltip suffix

### Fixed
- Strategy 1 (sessionDir) scope incorrectly stamped as `"fallback"` instead of `"workspace"`, causing spurious `recovered` badges on all sessions when using `sessionDir`

## [0.0.15] - 2026-02-18

### Added
- Copilot `runSubagent` tool call detection: parses `toolInvocationSerialized` entries from the response array to extract subagent descriptions and child tool calls (closes #28)
- Subagent child tools now counted in Metrics Dashboard tool usage (previously invisible)
- Session Explorer shows subagent tool calls with description and summarized child tool list
- MCP tool call detection: parses `source` field from response array to identify MCP server origin per tool call (closes #32)
- MCP server badges on tool tags in Session Explorer (blue-tinted with server name)
- MCP tool calls grouped by server in Session Explorer detail view
- MCP Servers bar chart in Metrics Dashboard (shown only when MCP data exists)
- Environment badge in Session Explorer: sessions recorded via SSH Remote, Dev Container, or WSL show a subtle `SSH` / `container` / `WSL` badge alongside the provider badge
- `Session.environment` field propagated from `vscode.env.remoteName` at discovery time
- Diagnostic report (`Agent Lens: Diagnose Session Discovery`) now shows `X session file(s), Y non-empty` for each Copilot strategy — makes it immediately obvious when VS Code has lazy-written empty files
- Refresh summary log now includes `(N non-empty)` session count
- Copilot hash instability mitigation (closes #26): sessions found under stale workspace hashes (e.g. after a container rebuild) now surface a `recovered` badge in Session Explorer with a tooltip showing the original workspace URI; a one-time info notification appears when stale-hash sessions are found that aren't in the current hash
- `Session.matchedWorkspace` field now populated from the `workspace.json` of the hash directory where each session was found
- `Session.scope` stamped as `"workspace"` (current hash) or `"fallback"` (stale hash) on all Copilot sessions

### Changed
- Copilot sessions without a `customTitle` now show the first user message as the title (truncated to 80 chars) instead of the raw GUID
- Reduced output channel noise: demoted per-file discovery and strategy-level logs from `info` to `debug` — only activation and refresh summary remain at `info`
- Missing session directories (ENOENT) now log at `debug` instead of `warn`
- `logger.ts`: debug output suppressed by default; enable with `AGENT_LENS_LOG_LEVEL=debug` or `AGENT_LENS_DEBUG=1`

## [0.0.14] - 2026-02-16

### Added
- Progress notification ("Scanning sessions...") when opening Metrics Dashboard, Session Explorer, or Agent Graph (#29)
- Empty sessions (0 requests) are now filtered from Session Explorer and Metrics Dashboard, with a count of hidden sessions shown (#29)
- "similar workspace" badge on Copilot sessions found via folder-name fallback (strategy 3) — warns that these may be from a different workspace with the same folder name (#25)
- `Session.scope` field to track discovery strategy: `"workspace"` or `"fallback"`
- Codex sessions now show the first user prompt as the session title instead of the raw session ID (#30)

### Changed
- Metrics Dashboard "Sessions" stat card now only counts sessions with at least 1 request

### Fixed
- Codex parser no longer creates phantom turns from injected context messages (AGENTS.md, environment_context) (#30)
- Codex parser now properly segments turns in legacy sessions without task_started events (#30)
- Codex session titles strip IDE context wrapper to show the actual user request (#30)

## [0.0.13] - 2026-02-16

### Added
- `Agent Lens: Diagnose Session Discovery` command: outputs structured environment and discovery status to the Output Channel — paths checked, accessibility, file counts per provider (closes #27)
- Advanced container setup documentation (`docs/container-setup.md`) covering WSL, SSH, Docker-in-Docker, hash instability, and portable mount configurations
- WSL-specific guidance: `VSCODE_CHAT_STORAGE` environment variable approach for portable `devcontainer.json`

### Changed
- Setup panel rewritten to focus on Copilot Chat (the only provider needing a mount); Claude and Codex noted as automatic (closes #23)
- Setup panel now includes platform-specific mount examples (macOS, Linux, WSL), session persistence guidance, troubleshooting section, and link to advanced docs
- Settings scope changed to `machine-overridable` for `sessionDir`, `claudeDir`, and `codexDir` — allows `.vscode/settings.json` to override container-specific paths without affecting the host (#23)

## [0.0.12] - 2026-02-15

### Added
- OpenAI Codex CLI session support: parses rollout JSONL files from `~/.codex/sessions/` into `Session`/`SessionRequest` model (closes #13)
- `CodexSessionProvider` with file discovery, JSONL parsing, and file watching
- Codex session locator: scans `agentLens.codexDir` setting, `CODEX_HOME` env, or default `~/.codex/sessions/`
- "Codex" filter toggle in Session Explorer and Metrics Dashboard
- Green provider badge for Codex sessions in Session Explorer
- `agentLens.codexDir` configuration setting for devcontainer/remote environments
- Codex section in Container Setup Guide with mount instructions
- Updated research doc with verified Codex JSONL envelope format
- Claude Code skill discovery: scans `.claude/skills/*/SKILL.md` following the Agent Skills standard
- Provider disambiguation across all views (closes #17)
  - Sidebar: agents and skills grouped into collapsible sections per provider (e.g. "Agents (Copilot)", "Skills (Claude)")
  - Agent Graph: Copilot / Claude toggle (no "All" — one provider preselected for readability)
  - Metrics Dashboard: unused agents/skills grouped by provider; sections respond to active filter
  - Session Explorer: filter buttons stay visible when no sessions match selected filter
- `provider` field on `Skill` model, propagated through parser, discovery, graph builder, and metrics
- 28 new tests (167 total)

## [0.0.11] - 2026-02-15

### Added
- Claude Code agent discovery: scans `.claude/agents/*.md` (project-level) and `~/.claude/agents/*.md` (global) for sub-agent definitions (closes #10)
- `AgentProvider` type (`"copilot" | "claude"`) and `provider` field on `Agent` model
- Purple graph nodes (`#b392f0`) for Claude agents in Agent Graph
- "(Claude)" badge in sidebar tree view for Claude agents
- Activation event and file watcher for `.claude/agents/*.md`
- Issue-linking convention in CLAUDE.md
- 6 new tests (139 total)

### Fixed
- `claudeDir` config now scans both the configured directory and the default `~/.claude/projects/` path, merging and deduplicating results — previously the configured dir replaced the default lookup (fixes #14)

## [0.0.10] - 2026-02-15

### Changed
- Added metrics dashboard screenshot to README
- Added .DS_Store to .gitignore

## [0.0.9] - 2026-02-14

### Changed
- Rewrote README for VS Code marketplace: clear value proposition, feature descriptions, getting started guide, removed dev docs

## [0.0.8] - 2026-02-14

### Changed
- Renamed extension from "Copilot Lens" to "Agent Lens" — new publisher `Proliminal`, updated all command IDs (`agentLens.*`), config keys, view container, and repo URLs
- CI release workflow now publishes to VS Code Marketplace automatically on git tag push

### Added
- Claude Code session parser: parses JSONL session files into `Session`/`SessionRequest` model (closes #5)
- `ClaudeSessionProvider` now calls the parser and returns parsed sessions
- Source filtering in Metrics Dashboard and Session Explorer: segmented toggle (All | Copilot | Claude) filters sessions by provider (closes #7)
- `SessionProviderType` union type (`"copilot" | "claude"`) and `provider` field on `Session` model
- Provider badges in Session Explorer (blue for Copilot, purple for Claude)
- Reverse messaging: webview filter changes flow to extension host for re-aggregation
- Cache token metrics: `cacheReadTokens` and `cacheCreationTokens` fields on `SessionRequest.usage`, aggregated in `AggregatedMetrics.cacheTokens` (closes #8)
- Cache stat cards in Metrics Dashboard: Cache Read Tokens, Cache Creation Tokens, Cache Hit Ratio (shown only when cache data exists)
- Input Token Breakdown donut chart: visualizes cache read vs cache creation vs non-cached input tokens
- Session Explorer detail view shows cache token counts per request
- Empty state for Agent Graph: shows guidance and doc links when no agents or skills are found
- 18 unit tests for Claude session parsing, 133 total

### Fixed
- Claude session discovery in devcontainers/SSH: multi-strategy cascade (encoded path variants, direct scan, folder name suffix match) handles path mismatches between container and host
- Underscore-to-dash path variant matching for container workspaces (e.g. `ex_a2ui` → `ex-a2ui`)

## [0.0.7] - 2026-02-13

### Added
- Token distribution donut charts: tokens by agent, tokens by model, prompt vs completion ratio (closes #2)
- Hover tooltips on Agent Usage bar chart: shows total tokens, avg prompt size, avg completion size per agent
- `TokenEntry` data model and `tokensByAgent` / `tokensByModel` fields in aggregated metrics
- Design spec for donut charts feature (`docs/design/donut-charts.md`)

### Removed
- Activity timeline chart from the Metrics Dashboard (low value)

## [0.0.6] - 2026-02-13

### Added
- Project scaffolding: CLAUDE.md, .gitignore, .github/ structure
- Design spec (docs/design/spec.md)
- Data sources research with real session schema analysis (docs/research/data-sources.md)
- Example agents: Planner, Implementer, Reviewer (`.github/agents/`)
- Example skills: testing, vscode-extensions (`.github/skills/`)
- Copilot instructions (`.github/copilot-instructions.md`)
- Roadmap with 9 milestones (ROADMAP.md)
- Extension skeleton: package.json, esbuild bundler, vitest, TypeScript config, VS Code launch/tasks
- Minimal extension entry point with `activate()` / `deactivate()`
- Data models: `Agent`, `Skill`, `Handoff`, `GraphNode`, `GraphEdge`, `Graph` interfaces
- Frontmatter parser: extracts YAML frontmatter + markdown body from `.agent.md` and `SKILL.md` files
- Agent parser: `.agent.md` content → `Agent` model (name, tools, model, handoffs, body)
- Skill parser: `SKILL.md` content → `Skill` model (name, description, body)
- File discovery: find all agent/skill files in workspace via `vscode.workspace.findFiles`; supports both `skills/*/SKILL.md` and `skills/*.skill.md` conventions
- Graph builder: constructs node/edge graph from agents and skills, resolves handoff targets, warns on broken references
- Optional built-in Copilot agents (Ask, Edit, Agent) as graph nodes
- 28 unit tests across parsers and graph builder
- Sidebar tree view: agents and skills with collapsible hierarchy (tools, models, handoffs as children)
- Activity bar icon (telescope) and refresh command
- Click-to-open agent/skill files from tree view
- Interactive D3 force-directed graph webview (Lit + D3.js)
- Color-coded nodes: agents (blue), skills (teal), built-in (light blue)
- Directed edges with arrowheads, dashed lines for manual handoffs
- Zoom, pan, node dragging, hover tooltips, edge labels
- Separate browser bundle for webview (esbuild ESM)
- Session data models: `Session`, `SessionRequest`, `ToolCallInfo`, `SkillRef`
- JSONL session parser: reconstructs sessions from kind=0/1/2 incremental patches
- Chat replay parser: imports `.chatreplay.json` manual exports
- Custom agent detection: extracts agent name from `inputState.mode` file URI in JSONL sessions, with `<modeInstructions>` fallback
- Skill detection: parses `<skills>` XML for available skills, `read_file` tool calls for loaded skills
- Session locator: finds `chatSessions/` directory from extension storage URI
- 50 unit tests total
- Metrics data model: `AggregatedMetrics`, `CountEntry`, `ActivityEntry`
- Metrics collector: aggregates agent/model/tool/skill usage, token totals, activity timeline, unused detection
- Metrics dashboard webview (Lit): stat cards, bar charts, activity timeline, unused agents/skills warnings
- `Copilot Lens: Show Metrics Dashboard` command
- Auto-discovers session files on activation
- 66 unit tests total
- Session Explorer webview: session picker sorted by date, vertical timeline of requests
- Agent switch and model switch highlighting with colored badges
- Click request to expand detail view (full prompt, tool calls, skills, timing, tokens)
- `Copilot Lens: Session Explorer` command
- Actions section in sidebar tree view with quick-launch buttons for Graph, Metrics, and Session Explorer
- DAG layout for agent graph: layered left-to-right topological ordering with auto-fit to viewport
- Bezier curve edges between graph nodes
- Structured startup and refresh logging via Output Channel: timing, discovery counts, session strategy tracing, and error diagnostics (closes #4)
- Logger singleton (`src/logger.ts`) with `[INFO]`/`[WARN]`/`[ERROR]` prefixes for the "Agent Lens" output channel
- CI workflow with CodeQL static analysis, npm audit, and dependency review on PRs
- Auto-refresh: file system watchers on agent, skill, and session files trigger debounced refresh automatically (closes #3)
- Panels (Graph, Metrics, Session Explorer) now re-scan before displaying to ensure fresh data

### Fixed
- Webview panels rendering blank: HTML now uses Lit custom elements instead of empty div containers
- Graph fills full viewport height (was clipped mid-screen)
- VS Code build task failing with exit code 127: tasks.json uses shell type with fnm init
- Session discovery in devcontainers/WSL2: scans sibling workspace hash directories to find sessions when the storage hash differs from the original
- `agentLens.sessionDir` setting: manually specify a session directory or mounted `workspaceStorage` root for devcontainer environments where sessions live on the host
- Click-to-open agent/skill files broken on Windows: was using relative path with `Uri.file()`, now preserves the original URI from discovery
- Malformed YAML frontmatter in agent/skill files no longer crashes the Refresh command; bad files are skipped with a console warning (fixes #1)
- Tree view sort order no longer shuffles on refresh; agents and skills are sorted alphabetically by name
- Custom agent names now correctly detected from JSONL sessions: tracks `inputState.mode` changes and correlates them with requests instead of relying solely on system prompt regex
