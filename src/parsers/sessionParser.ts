import type {
  Session,
  SessionRequest,
  ToolCallInfo,
  SkillRef,
} from "../models/session.js";
import {
  detectCustomAgent,
  detectAvailableSkills,
  detectLoadedSkills,
  extractAgentNameFromUri,
} from "./detectors.js";

// --- JSONL parser ---

interface JsonlLine {
  kind: number;
  k?: (string | number)[];
  v: unknown;
}

function setNestedValue(obj: Record<string, unknown>, path: (string | number)[], value: unknown): void {
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (current && typeof current === "object") {
      current = (current as Record<string | number, unknown>)[key];
    }
  }
  if (current && typeof current === "object") {
    const lastKey = path[path.length - 1];
    (current as Record<string | number, unknown>)[lastKey] = value;
  }
}

function appendToArray(obj: Record<string, unknown>, path: (string | number)[], items: unknown[]): void {
  let current: unknown = obj;
  for (const key of path) {
    if (current && typeof current === "object") {
      current = (current as Record<string | number, unknown>)[key];
    }
  }
  if (Array.isArray(current)) {
    current.push(...items);
  }
}

export async function parseSessionJsonl(content: string): Promise<Session> {
  if (!content.trim()) {
    return {
      sessionId: "unknown",
      title: null,
      creationDate: 0,
      requests: [],
      source: "jsonl",
      provider: "copilot",
    };
  }

  const lines = content.split("\n").filter((l) => l.trim());
  const state: Record<string, unknown> = {};

  // Track inputState.mode changes to attribute custom agents to requests.
  // Mode changes (kind=1 patches to ["inputState","mode"]) are interleaved
  // with request appends (kind=2 to ["requests"]), so the most recently set
  // mode tells us which custom agent was active for each request.
  let currentAgentName: string | null = null;
  const agentNameByRequest: (string | null)[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Yield every 500 lines to prevent blocking the event loop
    if (i > 0 && i % 500 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    switch (parsed.kind) {
      case 0: {
        Object.assign(state, parsed.v as Record<string, unknown>);
        const v = parsed.v as Record<string, unknown>;
        const inputState = v.inputState as Record<string, unknown> | undefined;
        const mode = inputState?.mode as Record<string, unknown> | undefined;
        if (mode?.kind === "agent" && typeof mode.id === "string") {
          currentAgentName = extractAgentNameFromUri(mode.id);
        }
        break;
      }
      case 1:
        if (parsed.k) {
          setNestedValue(state, parsed.k, parsed.v);
          if (parsed.k[0] === "inputState" && parsed.k[1] === "mode") {
            const mode = parsed.v as Record<string, unknown> | null;
            if (mode?.kind === "agent" && typeof mode.id === "string") {
              currentAgentName = extractAgentNameFromUri(mode.id);
            } else {
              currentAgentName = null;
            }
          }
        }
        break;
      case 2:
        if (parsed.k && Array.isArray(parsed.v)) {
          if (parsed.k.length === 1 && parsed.k[0] === "requests") {
            for (let j = 0; j < parsed.v.length; j++) {
              agentNameByRequest.push(currentAgentName);
            }
          }
          appendToArray(state, parsed.k, parsed.v);
        }
        break;
    }
  }

  return extractSession(state, "jsonl", agentNameByRequest);
}

// --- Chat replay parser ---

export function parseChatReplay(content: string): Session {
  const data = JSON.parse(content);

  const requests: SessionRequest[] = [];

  for (const prompt of data.prompts ?? []) {
    const requestLog = (prompt.logs ?? []).find(
      (l: Record<string, unknown>) => l.kind === "request",
    );
    if (!requestLog) continue;

    const meta = requestLog.metadata ?? {};
    const toolCallLogs = (prompt.logs ?? []).filter(
      (l: Record<string, unknown>) => l.kind === "toolCall",
    );

    const toolCalls: ToolCallInfo[] = toolCallLogs.map(
      (tc: Record<string, unknown>) => ({
        id: String(tc.id ?? ""),
        name: String(tc.tool ?? ""),
      }),
    );

    const toolCallArgs: Record<string, string> = {};
    for (const tc of toolCallLogs) {
      toolCallArgs[String(tc.id)] = String(tc.args ?? "");
    }

    // Detect custom agent from system messages
    let systemText = "";
    const messages = requestLog.requestMessages?.messages ?? [];
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        systemText += msg.content + "\n";
      }
    }

    const customAgentName = detectCustomAgent(systemText);
    const availableSkills = detectAvailableSkills(systemText);
    const loadedSkills = detectLoadedSkills(toolCalls, toolCallArgs);

    requests.push({
      requestId: String(requestLog.id ?? prompt.promptId ?? ""),
      timestamp: meta.startTime ? new Date(meta.startTime).getTime() : 0,
      agentId: String(requestLog.name ?? ""),
      customAgentName,
      modelId: String(meta.model ?? ""),
      messageText: String(prompt.prompt ?? ""),
      timings: {
        firstProgress: meta.timeToFirstToken ?? null,
        totalElapsed: meta.duration ?? null,
      },
      usage: {
        promptTokens: meta.usage?.prompt_tokens ?? 0,
        completionTokens: meta.usage?.completion_tokens ?? 0,
      },
      toolCalls,
      availableSkills,
      loadedSkills,
    });
  }

  return {
    sessionId: data.prompts?.[0]?.promptId ?? "unknown",
    title: null,
    creationDate: data.exportedAt ? new Date(data.exportedAt).getTime() : 0,
    requests,
    source: "chatreplay",
    provider: "copilot",
  };
}

// --- Subagent enrichment ---

/**
 * Scan a request's response array for toolInvocationSerialized entries
 * to replace runSubagent tool calls with enriched versions that include
 * descriptions and child tool lists.
 *
 * The response array uses different IDs than toolCallRounds, and may
 * contain subagent invocations not present in toolCallRounds. So we
 * treat the response array as the source of truth for runSubagent data:
 * remove any runSubagent entries from toolCalls and replace them with
 * entries built from the response array.
 */
function enrichSubagentToolCalls(
  toolCalls: ToolCallInfo[],
  rawRequest: unknown,
): void {
  const r = rawRequest as Record<string, unknown>;
  const response = r.response as unknown[] | undefined;
  if (!Array.isArray(response)) return;

  // Build maps from response entries
  const subagentParents = new Map<string, string>(); // toolCallId → description
  const childrenByParent = new Map<string, ToolCallInfo[]>();
  // Track insertion order for stable output
  const parentOrder: string[] = [];

  for (const entry of response) {
    const e = entry as Record<string, unknown>;
    if (e.kind !== "toolInvocationSerialized") continue;

    const toolCallId = e.toolCallId as string | undefined;
    const toolId = e.toolId as string | undefined;
    const parentId = e.subAgentInvocationId as string | undefined;

    // Collect runSubagent parents (take first occurrence per toolCallId)
    if (toolId === "runSubagent" && toolCallId) {
      const tsd = e.toolSpecificData as Record<string, unknown> | undefined;
      if (tsd?.kind === "subagent" && !subagentParents.has(toolCallId)) {
        subagentParents.set(toolCallId, String(tsd.description ?? ""));
        parentOrder.push(toolCallId);
      }
    }

    // Collect child tool calls grouped by parent subAgentInvocationId
    if (parentId && toolCallId) {
      let children = childrenByParent.get(parentId);
      if (!children) {
        children = [];
        childrenByParent.set(parentId, children);
      }
      children.push({
        id: toolCallId,
        name: String(toolId ?? ""),
      });
    }
  }

  if (subagentParents.size === 0) return;

  // Remove toolCallRounds-based runSubagent entries (IDs don't match)
  // and find the position of the first one for insertion
  let insertIndex = toolCalls.findIndex((tc) => tc.name === "runSubagent");
  if (insertIndex === -1) insertIndex = toolCalls.length;

  const filtered = toolCalls.filter((tc) => tc.name !== "runSubagent");
  toolCalls.length = 0;
  toolCalls.push(...filtered);

  // Insert enriched entries from response array at the original position
  const enriched: ToolCallInfo[] = parentOrder.map((id) => ({
    id,
    name: "runSubagent",
    subagentDescription: subagentParents.get(id),
    childToolCalls: childrenByParent.get(id) ?? [],
  }));

  toolCalls.splice(insertIndex, 0, ...enriched);
}

// --- MCP source extraction ---

/**
 * Scan a request's response array for toolInvocationSerialized entries
 * with MCP source metadata. Returns a map of tool name → server label.
 * The same tool name always belongs to the same MCP server, so we can
 * match by name rather than by ID.
 */
function extractMcpSources(rawRequest: unknown): Map<string, string> {
  const r = rawRequest as Record<string, unknown>;
  const response = r.response as unknown[] | undefined;
  const mcpMap = new Map<string, string>();
  if (!Array.isArray(response)) return mcpMap;

  for (const entry of response) {
    const e = entry as Record<string, unknown>;
    if (e.kind !== "toolInvocationSerialized") continue;

    const source = e.source as Record<string, unknown> | undefined;
    if (source?.type !== "mcp") continue;

    const toolId = e.toolId as string | undefined;
    const serverLabel = source.serverLabel as string | undefined;
    if (toolId && serverLabel && !mcpMap.has(toolId)) {
      mcpMap.set(toolId, serverLabel);
    }
  }

  return mcpMap;
}

/**
 * Apply MCP server labels to tool calls and their children.
 */
function applyMcpSources(
  toolCalls: ToolCallInfo[],
  mcpMap: Map<string, string>,
): void {
  if (mcpMap.size === 0) return;
  for (const tc of toolCalls) {
    const server = mcpMap.get(tc.name);
    if (server) {
      tc.mcpServer = server;
    }
    if (tc.childToolCalls) {
      applyMcpSources(tc.childToolCalls, mcpMap);
    }
  }
}

// --- Shared extraction ---

function extractSession(
  state: Record<string, unknown>,
  source: "jsonl" | "json",
  agentNameByRequest?: (string | null)[],
): Session {
  const rawRequests = (state.requests as unknown[]) ?? [];

  const requests: SessionRequest[] = rawRequests.map((raw, index) => {
    const r = raw as Record<string, unknown>;
    const agent = r.agent as Record<string, unknown> | undefined;
    const result = r.result as Record<string, unknown> | undefined;
    const meta = result?.metadata as Record<string, unknown> | undefined;
    const timings = result?.timings as Record<string, number> | undefined;
    const usage = result?.usage as Record<string, number> | undefined;

    // Extract tool calls from toolCallRounds
    const toolCalls: ToolCallInfo[] = [];
    const toolCallArgs: Record<string, string> = {};
    const rounds = (meta?.toolCallRounds as unknown[]) ?? [];
    for (const round of rounds) {
      const r = round as Record<string, unknown>;
      for (const tc of (r.toolCalls as Record<string, unknown>[]) ?? []) {
        toolCalls.push({
          id: String(tc.id ?? ""),
          name: String(tc.name ?? ""),
        });
      }
    }

    // Enrich runSubagent tool calls with metadata from response array
    enrichSubagentToolCalls(toolCalls, raw);

    // Extract and apply MCP server labels from response array
    const mcpMap = extractMcpSources(raw);
    applyMcpSources(toolCalls, mcpMap);

    // Extract tool call args from toolCallResults for skill detection
    const toolCallResults = (meta?.toolCallResults ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [id, result] of Object.entries(toolCallResults)) {
      const content = result.content as Record<string, unknown>[] | undefined;
      if (content?.[0]) {
        toolCallArgs[id] = String(content[0].value ?? "");
      }
    }

    // Detect custom agent and skills from rendered system prompt
    let systemText = "";
    const rendered = meta?.renderedUserMessage;
    if (Array.isArray(rendered)) {
      for (const part of rendered) {
        const p = part as Record<string, unknown>;
        if (typeof p.value === "string") {
          systemText += p.value + "\n";
        }
      }
    }

    const customAgentName = agentNameByRequest?.[index] ?? detectCustomAgent(systemText);
    const availableSkills = detectAvailableSkills(systemText);
    const loadedSkills = detectLoadedSkills(toolCalls, toolCallArgs);

    const message = r.message as Record<string, unknown> | undefined;

    return {
      requestId: String(r.requestId ?? ""),
      timestamp: (r.timestamp as number) ?? 0,
      agentId: String(agent?.id ?? ""),
      customAgentName,
      modelId: String(r.modelId ?? ""),
      messageText: String(message?.text ?? ""),
      timings: {
        firstProgress: timings?.firstProgress ?? null,
        totalElapsed: timings?.totalElapsed ?? null,
      },
      usage: {
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
      },
      toolCalls,
      availableSkills,
      loadedSkills,
    };
  });

  // Use customTitle if set by Copilot Chat, otherwise fall back to
  // the first user message (truncated) so sessions aren't just GUIDs.
  let title = (state.customTitle as string) ?? null;
  if (!title && requests.length > 0) {
    const firstMsg = requests[0].messageText.trim();
    if (firstMsg) {
      title = firstMsg.length > 80 ? firstMsg.slice(0, 80) + "\u2026" : firstMsg;
    }
  }

  return {
    sessionId: String(state.sessionId ?? "unknown"),
    title,
    creationDate: (state.creationDate as number) ?? 0,
    requests,
    source,
    provider: "copilot",
  };
}
