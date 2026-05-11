# Agent Lens — Epics

> Large feature initiatives informed by recent developments in Claude Code and GitHub Copilot (March 2026 analysis). Each epic breaks down into individual issues. Epics are independent — no cross-epic dependencies.
>
> Recommended execution order: E7 → E4 → E3 → E1 → E5 → E6 → E2 (quick wins first, research-heavy items later).

---

## E1: Copilot CLI Session Discovery & Parsing

**Goal:** Add a new session provider for GitHub Copilot CLI (`~/.copilot/session-state/`), which stores agent sessions in a different format and location than VS Code Copilot Chat.

**Background:**
Copilot CLI (GA Feb 2026) is a standalone agentic CLI with its own session storage at `~/.copilot/session-state/{session-id}/events.jsonl`. It has built-in subagents (Explore, Task, Code Review, Plan) that map cleanly to Agent Lens's existing subagent visualization. This is a rapidly growing user base that Agent Lens currently misses entirely.

**Scope:**
- **In:** Discovery, parsing, caching, watch targets, timeline rendering, metrics integration
- **Out:** Copilot Coding Agent (cloud-hosted, no local sessions), Copilot Metrics API

### Issues

| # | Title | Type | Description |
|---|-------|------|-------------|
| 1 | Research Copilot CLI session file format | `research` | Reverse-engineer the `events.jsonl` schema at `~/.copilot/session-state/`. Document record types, fields, subagent representation, tool call format, token usage fields. Compare with existing Copilot Chat JSONL format. |
| 2 | Add `copilotCliLocator.ts` | `feat` | Detect `~/.copilot/session-state/` (or `$COPILOT_CLI_HOME`). Platform-specific paths (macOS/Linux/Windows). Return session directories. |
| 3 | Add `copilotCliSessionParser.ts` | `feat` | Pure function: parse `events.jsonl` → `Session` model. Handle subagent records, tool calls, token usage, model IDs. Yield event loop every N lines. |
| 4 | Add `copilotCliProvider.ts` implementing `SessionProvider` | `feat` | Wire locator + parser. Mtime-based caching. Global and workspace-scoped discovery. `getWatchTargets()` returning glob patterns. |
| 5 | Register provider in `extension.ts` | `feat` | Register `CopilotCliSessionProvider` in the session registry. Add `agentLens.copilotCliDir` config option. Add file watchers. |
| 6 | Update `SessionProviderType` and UI filters | `feat` | Add `"copilot-cli"` to `SessionProviderType`. Update session explorer filter dropdown, metrics provider breakdown, graph node kinds. |
| 7 | Tests | `test` | Unit tests for locator, parser, provider. Test files from real Copilot CLI sessions. |

### Acceptance Criteria

- Copilot CLI sessions appear in Session Explorer with correct timeline, subagent swimlanes, tool calls
- Metrics dashboard includes Copilot CLI sessions in all aggregations
- File watcher auto-refreshes on new Copilot CLI sessions
- Works when `~/.copilot/` doesn't exist (graceful no-op)

### Technical Notes

- Follow the exact same pattern as `codexProvider.ts` / `claudeProvider.ts`
- The `SessionProvider` interface is the extension point — no changes to registry needed
- Copilot CLI likely uses a different JSONL schema than VS Code Copilot Chat's patch-based format — research issue is critical before implementation

---

## E2: Claude Code OpenTelemetry Integration

**Goal:** Consume Claude Code's native OTEL events to provide real-time and enriched session observability — tool call durations, API request costs, prompt-level correlation, and error tracking.

**Background:**
Claude Code exports OTEL metrics and events when `CLAUDE_CODE_ENABLE_TELEMETRY=1`. Events include `tool_result` (with `duration_ms`, `success`, `tool_parameters`), `api_request` (with `cost_usd`, token breakdown), and `user_prompt` — all correlated by `prompt.id`. This data is richer than what JSONL parsing alone provides (e.g., tool call durations and costs are not in session files).

**Scope:**
- **In:** OTEL event consumption, data enrichment of existing sessions, cost/duration metrics
- **Out:** Running a full OTEL collector, real-time streaming dashboard (future epic), metrics-only signals (we focus on events)

### Issues

| # | Title | Type | Description |
|---|-------|------|-------------|
| 1 | Research OTEL event format and collection options | `research` | Document the exact OTEL event schemas Claude Code emits. Evaluate collection strategies: (a) file-based OTLP exporter writing to local files, (b) lightweight HTTP receiver in the extension, (c) reading from an existing collector's storage. Determine the simplest path that doesn't require users to run infrastructure. |
| 2 | Design OTEL data model extensions | `feat` | Extend `ToolCallInfo` with optional `durationMs`, `success`, `errorMessage`. Extend `SessionRequest` with optional `costUsd`, `apiDurationMs`. Add `promptCorrelationId` for linking. |
| 3 | Add `otelEventParser.ts` | `feat` | Parse OTEL event records (OTLP JSON or file-based export) into enrichment data. Map `prompt.id` → tool results, API requests. Pure function, testable. |
| 4 | Add OTEL enrichment pass to Claude provider | `feat` | After JSONL parsing, optionally enrich sessions with OTEL data: merge tool durations, costs, error flags into existing `ToolCallInfo` and `SessionRequest` objects by correlating `session.id` + timestamps. |
| 5 | Surface enriched data in timeline tooltip | `feat` | Update timeline tooltip to show tool call duration (ms), API request cost ($), and error indicators when OTEL data is available. Subtle visual indicator (e.g., border color) for errored tool calls. |
| 6 | Surface enriched data in metrics dashboard | `feat` | Add cost-per-session, cost-per-agent, average tool call duration charts. Only shown when OTEL data is available. |
| 7 | Add `agentLens.otelDir` config + setup guidance | `feat` | Config option pointing to OTEL export directory. Update Setup Panel with instructions for enabling `CLAUDE_CODE_ENABLE_TELEMETRY=1` and configuring a file exporter. |
| 8 | Tests | `test` | Unit tests for OTEL parser, enrichment logic. Mock OTEL event files. |

### Acceptance Criteria

- When OTEL data is available, tool calls show duration and success/failure in timeline
- Cost metrics appear in the dashboard per session, agent, and model
- Graceful degradation: everything works normally without OTEL data
- No requirement for users to run external OTEL infrastructure

### Technical Notes

- Simplest approach: Claude Code can export OTEL to files via `OTEL_EXPORTER_OTLP_ENDPOINT=file:///path`. Agent Lens reads those files.
- Alternative: lightweight HTTP listener in the extension process — more complex but enables real-time
- The `prompt.id` UUID is the key correlation mechanism linking prompts → tool calls → API requests
- `OTEL_LOG_TOOL_DETAILS=1` is needed for MCP server/tool names

---

## E3: Compaction & Context Management Events in Timeline

**Goal:** Visualize Claude Code's context compaction events as markers in the session timeline, helping users understand when and why context was compressed.

**Background:**
Claude Code writes `compact_boundary` records to session JSONL when context approaches ~167K tokens. These records include `compactMetadata.trigger` ("auto"/"manual") and `compactMetadata.preTokens`. A subsequent `isCompactSummary: true` message contains the compressed summary. This information is currently ignored by the parser.

**Scope:**
- **In:** Parsing compaction records, timeline markers, token pressure visualization
- **Out:** Editing compaction behavior, showing full summary content

### Issues

| # | Title | Type | Description |
|---|-------|------|-------------|
| 1 | Parse `compact_boundary` records in `claudeSessionParser.ts` | `feat` | Detect system records with `compactMetadata`. Extract trigger type, preTokens count, timestamp. Store as a new event type on the session. |
| 2 | Add `CompactionEvent` to session model | `feat` | New type: `{ timestamp, trigger: 'auto' \| 'manual', preTokens: number, postTokens?: number }`. Add `compactionEvents: CompactionEvent[]` to `Session`. |
| 3 | Render compaction markers in timeline | `feat` | Draw vertical dashed lines at compaction timestamps in the timeline SVG. Color: amber for auto, blue for manual. Tooltip: "Context compacted (auto) — 156K → ~32K tokens". |
| 4 | Add running token count indicator to timeline | `feat` | Optional thin line chart overlaid on the timeline showing cumulative token usage, with visible drops at compaction points. Toggle via a small checkbox in the timeline header. |
| 5 | Tests | `test` | Parser tests with compaction boundary records. Layout tests for marker positioning. |

### Acceptance Criteria

- Compaction events appear as vertical markers at correct timeline positions
- Tooltip shows trigger type and token counts
- Token pressure line (if enabled) shows the sawtooth pattern of usage → compaction → usage
- Non-Claude sessions unaffected (no markers, no errors)

### Technical Notes

- The `compact_boundary` is a system-type record — the parser currently skips non-assistant/user types, so we need to add handling
- `isCompactSummary: true` on the following user message can be used to detect the post-compaction state
- Timeline layout in `webview/timelineLayout.ts` needs a new `markers` array in the layout output

---

## E4: Session Naming from Slug & Named Sessions

**Goal:** Use Claude Code's `slug` field and explicit `--name` values to display human-readable session names instead of UUIDs or first-message excerpts.

**Background:**
Claude Code sessions now have a `slug` field (e.g., "zesty-singing-newell") that persists across continuations, plus support for explicit naming via `-n`/`--name` CLI flag. Currently Agent Lens derives session titles from the first user message or falls back to the session ID, which is less recognizable.

**Scope:**
- **In:** Claude session naming, Copilot/Codex session naming improvements if applicable
- **Out:** Renaming sessions from within Agent Lens

**Status:** Partially done. The original user-visible problem (GUIDs in the session picker, issue #58) was already resolved by using the `summary` field from `sessions-index.json` with a first-user-message fallback (`claudeSessionParser.ts:316-323`). Remaining work in this epic — slug parsing and explicit `--name` support — is an enhancement, not a fix, and provides cross-continuation identity (same slug persists across resumed sessions).

### Issues

| # | Title | Type | Description |
|---|-------|------|-------------|
| 1 | Extract `slug` field in `claudeSessionParser.ts` | `feat` | Read the `slug` field from any JSONL record (it appears on multiple records). Use as `Session.title` when available, with fallback to current behavior. |
| 2 | Extract explicit session name | `feat` | If a session was started with `--name`, the name appears in session metadata. Extract and prefer over slug. Priority: explicit name > slug > first message > session ID. |
| 3 | Update session picker UI | `feat` | Show slug/name prominently in the session dropdown. Format: "Session Name — Mar 16, 2026 14:30" instead of truncated first message. |
| 4 | Update session explorer details panel | `feat` | Show session name/slug in the header. Show session ID as secondary metadata. |
| 5 | Tests | `test` | Parser tests with slug field, named sessions, fallback behavior. |

### Acceptance Criteria

- Claude sessions with slugs show "zesty-singing-newell" style names in the picker
- Explicitly named sessions show their name
- Fallback chain: explicit name → slug → first message → session ID
- No regression for Copilot/Codex sessions

### Technical Notes

- The `slug` field is on JSONL records at the top level: `{ "slug": "zesty-singing-newell", "type": "user", ... }`
- It persists across session continuations (same slug, new sessionId)
- Parser currently reads `type`, `message`, `uuid`, `parentUuid`, `timestamp`, `sessionId` — adding `slug` is straightforward
- The `Session` model already has a `title` field — we just need to set it from slug/name

---

## E5: Claude Code Hook for Real-Time Refresh

**Goal:** Provide a Claude Code hook configuration that triggers Agent Lens session refresh in real-time when sessions end or subagents complete, replacing filesystem polling.

**Background:**
Claude Code supports 25 hook events. `SessionEnd` fires when a session completes, `SubagentStop` fires when a subagent finishes (with `agent_transcript_path`). Currently Agent Lens uses filesystem watchers with 2-second debounce. A hook-driven approach would be more immediate and precise.

**Scope:**
- **In:** Hook configuration, extension-side listener, targeted refresh
- **Out:** Modifying Claude Code's hook system, hooks for non-Claude providers

### Issues

| # | Title | Type | Description |
|---|-------|------|-------------|
| 1 | Design hook-to-extension communication | `research` | Evaluate approaches: (a) HTTP hook → lightweight localhost server in extension, (b) command hook writing to a trigger file that the file watcher picks up, (c) VS Code URI handler (`vscode://agentlens/refresh`). Recommend simplest reliable approach. |
| 2 | Implement extension-side listener | `feat` | Based on research: either register a VS Code URI handler, start a minimal localhost HTTP server, or set up a sentinel file watcher. Receive hook events and trigger targeted refresh. |
| 3 | Add targeted refresh for specific sessions | `feat` | Currently `scheduleRefresh()` re-discovers all sessions. Add `refreshSession(sessionId)` that re-parses only the affected session file and updates panels incrementally. |
| 4 | Ship hook configuration template | `feat` | Add `.claude/hooks/agent-lens.json` (or document in setup panel) with `SessionEnd` and `SubagentStop` hooks configured to notify the extension. Include install instructions. |
| 5 | Add setup guidance to Setup Panel | `feat` | New section in the setup panel explaining how to enable hooks for real-time refresh. One-click copy of hook configuration. |
| 6 | Tests | `test` | Test targeted refresh logic. Test hook payload parsing. Integration test with mock hook event. |

### Acceptance Criteria

- When a Claude Code session ends, Agent Lens refreshes within <1 second (vs current 2s debounce + full discovery)
- When a subagent completes, its data appears in the timeline without full re-scan
- Hook setup is documented and easy to configure
- Extension works normally without hooks (graceful fallback to file watchers)

### Technical Notes

- Simplest approach is likely VS Code URI handler: `vscode://agentlens/refresh?session=<id>` — no server needed, works cross-platform
- Hook config: `{ "type": "command", "command": "open 'vscode://agentlens/refresh?session=${SESSION_ID}'" }`
- `SubagentStop` hook payload includes `agent_transcript_path` — can be passed to skip discovery and parse directly
- File watcher remains as fallback; hook is an optimization layer

---

## E6: Claude Agent SDK as Parsing Backend

**Goal:** Use the Claude Agent SDK's `listSessions()` and `getSessionMessages()` TypeScript APIs as an alternative to raw JSONL file parsing, providing a more stable and forward-compatible session discovery mechanism.

**Background:**
The Claude Agent SDK (npm `@anthropic-ai/claude-agent-sdk` v0.2.71) exposes `listSessions()` and `getSessionMessages()` for programmatic session enumeration and reading. This is a stable API surface maintained by Anthropic, vs. the current approach of parsing raw JSONL files whose format can change between versions.

**Scope:**
- **In:** SDK-based discovery and parsing as an alternative backend, feature parity with JSONL parser
- **Out:** Replacing JSONL parsing entirely (SDK is an option, not a mandate), Python SDK

### Issues

| # | Title | Type | Description |
|---|-------|------|-------------|
| 1 | Evaluate SDK session API capabilities | `research` | Install `@anthropic-ai/claude-agent-sdk`. Test `listSessions()` and `getSessionMessages()` against real sessions. Document: what fields are returned, how subagents appear, whether token usage is included, whether it handles continuations, performance characteristics. Compare data completeness vs. JSONL parsing. |
| 2 | Add SDK as optional dependency | `feat` | Add `@anthropic-ai/claude-agent-sdk` to `package.json`. Lazy-load to avoid activation penalty. Detect whether `claude` CLI is installed (SDK requirement). |
| 3 | Implement `claudeSdkProvider.ts` | `feat` | New `SessionProvider` implementation using SDK APIs. Map SDK session/message objects to Agent Lens `Session`/`SessionRequest` models. Handle subagent correlation. Mtime-based caching (use session metadata timestamps). |
| 4 | Add provider selection config | `feat` | `agentLens.claudeBackend`: `"auto"` (SDK if available, JSONL fallback) \| `"sdk"` \| `"jsonl"`. Default: `"auto"`. |
| 5 | Ensure feature parity | `feat` | Verify that SDK-based parsing produces identical `Session` objects as JSONL parsing for the same sessions. Handle any gaps (e.g., if SDK doesn't expose compaction events, fall back to JSONL for those). |
| 6 | Tests | `test` | Unit tests with mocked SDK responses. Integration test comparing SDK vs. JSONL output for same session. |

### Acceptance Criteria

- `agentLens.claudeBackend: "sdk"` discovers and parses sessions using the Agent SDK
- Feature parity: same sessions, same requests, same tool calls, same metrics
- Graceful fallback: if SDK is unavailable (no `claude` CLI), falls back to JSONL parsing automatically
- No activation penalty: SDK is lazy-loaded only when needed

### Technical Notes

- The SDK spawns a `claude` subprocess — there may be a startup cost per call. Caching is critical.
- `listSessions()` returns session metadata (id, slug, timestamps) without full messages — use for discovery, then `getSessionMessages(id)` for detailed parsing
- The SDK may not expose all JSONL fields (e.g., `compact_boundary` records, raw content blocks) — JSONL parser remains the authoritative source for maximum detail
- Consider: SDK for discovery + listing, JSONL for detailed parsing (hybrid approach)
- Extension should not bundle the SDK if it's >5MB — use dynamic require with graceful failure

---

## E7: Session Title Quality from In-Session Metadata

**Goal:** Make session titles in the explorer reflect the user's actual intent by using Claude Code's `custom-title` and `ai-title` JSONL events, filtering out the `<local-command-caveat>` system scaffold and `isMeta` boilerplate, and synthesizing titles from slash-command tags when no user prose follows.

**Background:**
Many Claude sessions currently display titles like `<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these mes…` instead of meaningful content. Three independent root causes:

1. **Claude Code now writes title events into the JSONL** that Agent Lens ignores entirely:
   - `{"type":"custom-title","customTitle":"E-22","sessionId":"..."}` — set by the user (e.g. via `/title`)
   - `{"type":"ai-title","aiTitle":"Add severity or priority system for gaps","sessionId":"..."}` — generated by Claude Code itself
2. **`isSystemTag()` in [src/parsers/claudeSessionParser.ts:132-142](src/parsers/claudeSessionParser.ts#L132-L142) does not match `<local-command-caveat>`**, so the boilerplate caveat text becomes `firstUserText` and is rendered as the title (truncated to 80 chars). The caveat line also always has `isMeta: true`, which the parser currently ignores.
3. **Slash-command-initiated sessions** (`/clear`, `/effort`, `/exit`, custom commands) produce a `<command-name>/foo</command-name>` block followed sometimes by no free-text prompt. After filtering the caveat and the `<command-` tags, there is nothing left to title with.

Sampling one workspace (`ai-workflow-v2`, 72 sessions): **44/72 have a `custom-title` event**, **10/72 have an `ai-title` event** — most sessions are already named by Claude Code; we just don't read it. Of the 53 sessions whose first body line is a `user` record, **60 are `/clear` continuations**, 2 are `/effort`, 1 is `/exit`.

The `summary` argument the parser currently uses comes from `sessions-index.json` ([claudeLocator.ts:51-70](src/parsers/claudeLocator.ts#L51-L70)) and is `null` for most newer sessions — Claude Code moved that data into per-session JSONL events.

**Scope:**
- **In:** reading `custom-title` / `ai-title` JSONL events, filtering `<local-command-caveat>` and `isMeta: true` lines, synthesizing titles from `<command-name>` + `<command-args>` when nothing else exists, defining a clear title-source priority chain
- **Out:** editing titles from within Agent Lens (future work), slug / `--name` handling (covered by E4), title quality for Codex/Copilot sessions (separate effort if needed)

### Issues

| # | Title | Type | Description |
|---|-------|------|-------------|
| 1 | Parse `custom-title` and `ai-title` JSONL events | `feat` | Detect lines with `type === "custom-title"` / `type === "ai-title"` in [claudeSessionParser.ts](src/parsers/claudeSessionParser.ts). Capture `customTitle` / `aiTitle` strings into local variables in `parseClaudeSessionJsonl()`. The same event may appear multiple times in a file — last one wins. |
| 2 | Filter `<local-command-caveat>` from title derivation | `fix` | Add `trimmed.startsWith("<local-command-caveat")` to `isSystemTag()` at [claudeSessionParser.ts:133](src/parsers/claudeSessionParser.ts#L133). Also skip lines with `isMeta: true` in the `firstUserText` capture loop ([lines 212-248](src/parsers/claudeSessionParser.ts#L212-L248)) — it's the authoritative marker for system-injected user records. |
| 3 | Define title-source priority chain | `feat` | Replace the current `summary ?? firstUserText` fallback at [lines 316-323](src/parsers/claudeSessionParser.ts#L316-L323) with: `customTitle` → `aiTitle` → `summary` → `firstUserText` → `slashCommandSynth` → `null`. Preserve the existing 80-char truncation only for the free-text branches. |
| 4 | Synthesize titles from slash-command tags | `feat` | When `firstUserText` is empty and the first non-meta user record contains `<command-name>` (and optionally `<command-args>`), extract them and produce `"/foo bar baz"`. Strip the leading `/` only if it would be cosmetically nicer — keep the slash to make the source obvious. Skip for `/clear`, `/exit` (no useful intent — let the next user prompt provide the title instead). |
| 5 | Tests | `test` | Cover: session with only `custom-title`; session with only `ai-title`; both present (custom wins); caveat + `/clear` + real prompt → real prompt; caveat + `/effort foo` + no follow-up → `/effort foo`; caveat-only with no follow-up → `null`; legacy session with `summary` from index → unchanged; `isMeta: true` line is skipped. Add fixtures under `src/parsers/fixtures/` mirroring real JSONL shapes. |
| 6 | Update CHANGELOG and README | `docs` | Note the title-quality improvement under `[Unreleased]` in CHANGELOG. README only if a feature description references session titles. |

### Acceptance Criteria

- Sessions with a `custom-title` or `ai-title` event display that title, regardless of caveat presence
- Sessions starting with `<local-command-caveat>` no longer surface that text as the title
- `/clear`-continued sessions show the real follow-up prompt as the title
- Slash-command-only sessions (e.g. `/effort foo`) show `"/effort foo"` rather than `null` or empty
- Sessions with no title source at all fall back to `sessionId` (existing webview behavior at [webview/session.ts:857](webview/session.ts#L857) / [:879](webview/session.ts#L879) — no change needed)
- No regression for Codex / Copilot sessions (they don't share this code path)
- Existing tests in [claudeSessionParser.test.ts](src/parsers/claudeSessionParser.test.ts) still pass

### Technical Notes

- The `custom-title` / `ai-title` events typically appear as the **first one or two lines** of the JSONL, but we should scan the whole file (cheap — string compare per line) since Claude Code may write them later in the session lifecycle.
- `isMeta: true` is a more reliable signal than tag-string matching for system-injected user records — adopt it as the primary filter, with the tag list as a secondary safety net for older sessions without `isMeta`.
- The synthesized slash-command title for `/clear` is intentionally suppressed: `/clear` denotes continuation, and the user's real intent is the next prompt, which the existing `firstUserText` logic will pick up once the caveat is filtered out.
- The `summary` argument may eventually be removed if `custom-title` / `ai-title` cover the same ground — but keep it in the priority chain for now to avoid regressing sessions whose index still has a usable summary.
- Coordinate with E4: E4's `slug` would fit naturally between `aiTitle` and `summary` in the priority chain when implemented — leave a clear extension point.
