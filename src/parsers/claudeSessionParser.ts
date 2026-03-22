import type {
  Session,
  SessionRequest,
  ToolCallInfo,
} from "../models/session.js";

interface ClaudeLine {
  type: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    content?: ContentBlock[] | string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: { subagent_type?: string; skill?: string };
  tool_use_id?: string;
  content?: ContentBlock[] | string;
}

export interface SubagentInput {
  content: string;
  agentId: string;
  subagentType: string | null;
}

/**
 * Single-pass scan of main session content for Task/Agent tool_use blocks
 * and their corresponding tool_result responses. Returns:
 *   - typeMap: agentId -> subagentType (e.g., "abc123" -> "Explore")
 *   - parentMap: agentId -> parentRequestUuid (assistant message UUID)
 */
export function buildSubagentMaps(content: string): {
  typeMap: Map<string, string>;
  parentMap: Map<string, string>;
} {
  const lines = content.split("\n").filter((l) => l.trim());

  // From tool_use blocks
  const toolIdToType = new Map<string, string>();
  const toolIdToParentUuid = new Map<string, string>();
  // From tool_result blocks
  const toolIdToAgentId = new Map<string, string>();

  for (const line of lines) {
    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === "assistant" && !parsed.isSidechain) {
      const blocks = Array.isArray(parsed.message?.content)
        ? parsed.message!.content
        : [];
      for (const block of blocks) {
        if (
          block.type === "tool_use" &&
          (block.name === "Task" || block.name === "Agent") &&
          block.id &&
          block.input?.subagent_type
        ) {
          toolIdToType.set(block.id, block.input.subagent_type);
          toolIdToParentUuid.set(block.id, String(parsed.uuid ?? ""));
        }
      }
    }

    if (parsed.type === "user" && !parsed.isSidechain) {
      const blocks = Array.isArray(parsed.message?.content)
        ? parsed.message!.content
        : [];
      for (const block of blocks) {
        if (block.type === "tool_result" && block.tool_use_id) {
          // Look for "agentId: <id> (for resuming" pattern in content.
          // Use the LAST match — tool_result text may contain references
          // to other agents in the body, but the framework appends the
          // real agentId at the end.
          const text = extractToolResultText(block);
          let lastAgentId: string | null = null;
          for (const m of text.matchAll(
            /agentId: ([\w-]+) \(for resuming/g,
          )) {
            lastAgentId = m[1];
          }
          if (lastAgentId) {
            toolIdToAgentId.set(block.tool_use_id, lastAgentId);
          }
        }
      }
    }
  }

  // Correlate via shared toolUseId
  const typeMap = new Map<string, string>();
  const parentMap = new Map<string, string>();
  for (const [toolId, agentId] of toolIdToAgentId) {
    const subagentType = toolIdToType.get(toolId);
    if (subagentType) {
      typeMap.set(agentId, subagentType);
    }
    const parentUuid = toolIdToParentUuid.get(toolId);
    if (parentUuid) {
      parentMap.set(agentId, parentUuid);
    }
  }
  return { typeMap, parentMap };
}

/** @deprecated Use buildSubagentMaps instead */
export function buildSubagentTypeMap(content: string): Map<string, string> {
  return buildSubagentMaps(content).typeMap;
}

/** Check if text looks like a system-injected tag (e.g. <ide_opened_file>, <system-reminder>). */
function isSystemTag(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<ide_") ||
    trimmed.startsWith("<system-") ||
    trimmed.startsWith("<command-") ||
    trimmed.startsWith("<environment_") ||
    trimmed.startsWith("<user-prompt-submit-hook")
  );
}

function extractToolResultText(block: ContentBlock): string {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("\n");
  }
  return "";
}

/**
 * Parse a Claude Code session JSONL file into our Session model.
 *
 * Each line is a standalone JSON object with a `type` field.
 * We extract `assistant` messages (skipping sidechains) as requests,
 * and track `user` messages to populate `messageText`.
 *
 * When `subagents` is provided, their assistant messages are parsed
 * and interleaved into the timeline by timestamp.
 */
export async function parseClaudeSessionJsonl(
  content: string,
  summary: string | null,
  subagents?: SubagentInput[],
): Promise<Session> {
  if (!content.trim()) {
    return {
      sessionId: "unknown",
      title: summary,
      creationDate: 0,
      requests: [],
      source: "claude",
      provider: "claude",
    };
  }

  const lines = content.split("\n").filter((l) => l.trim());

  let sessionId = "unknown";
  let firstTimestamp = 0;
  let lastUserText = "";
  let firstUserText: string | null = null;
  const requests: SessionRequest[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Yield every 500 lines to prevent blocking the event loop
    if (i > 0 && i % 500 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    // Capture sessionId from any line
    if (parsed.sessionId && sessionId === "unknown") {
      sessionId = parsed.sessionId;
    }

    // Track first timestamp for creationDate
    if (parsed.timestamp && firstTimestamp === 0) {
      firstTimestamp = new Date(parsed.timestamp).getTime();
    }

    // Track latest user message text (filter out system-injected tags)
    if (parsed.type === "user" && !parsed.isSidechain && parsed.message?.content) {
      const content = parsed.message.content;
      if (typeof content === "string") {
        lastUserText = isSystemTag(content) ? "" : content;
      } else if (Array.isArray(content)) {
        const textBlocks = content.filter(
          (b) => b.type === "text" && b.text && !isSystemTag(b.text),
        );
        if (textBlocks.length > 0) {
          lastUserText = textBlocks.map((b) => b.text).join("\n");
        }
      }
      if (firstUserText === null) {
        // For title derivation, filter out system-injected text blocks
        // (e.g. <ide_opened_file>, <ide_selection>, <system-reminder>)
        let titleCandidate: string | undefined;
        if (typeof content === "string") {
          if (!isSystemTag(content)) {
            titleCandidate = content;
          }
        } else if (Array.isArray(content)) {
          const userBlocks = content.filter(
            (b) =>
              b.type === "text" &&
              b.text &&
              !isSystemTag(b.text),
          );
          if (userBlocks.length > 0) {
            titleCandidate = userBlocks[0].text;
          }
        }
        if (titleCandidate) {
          firstUserText = titleCandidate;
        }
      }
    }

    // Extract assistant messages as requests
    if (parsed.type === "assistant" && !parsed.isSidechain) {
      const msg = parsed.message;
      if (!msg) continue;

      const toolCalls: ToolCallInfo[] = [];
      const loadedSkills: string[] = [];
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (block.type === "tool_use" && block.id && block.name) {
          toolCalls.push({ id: block.id, name: block.name });
          if (block.name === "Skill" && block.input?.skill) {
            loadedSkills.push(block.input.skill);
          }
        }
      }

      const messageText = lastUserText;
      lastUserText = "";

      requests.push({
        requestId: String(parsed.uuid ?? ""),
        timestamp: parsed.timestamp
          ? new Date(parsed.timestamp).getTime()
          : 0,
        agentId: "claude-code",
        customAgentName: null,
        modelId: String(msg.model ?? ""),
        messageText,
        timings: {
          firstProgress: null,
          totalElapsed: null,
        },
        usage: {
          promptTokens: msg.usage?.input_tokens ?? 0,
          completionTokens: msg.usage?.output_tokens ?? 0,
          cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: msg.usage?.cache_creation_input_tokens ?? 0,
        },
        toolCalls,
        availableSkills: [],
        loadedSkills,
      });
    }
  }

  // Parse subagent content and merge into requests
  if (subagents) {
    const { parentMap } = buildSubagentMaps(content);

    for (const sub of subagents) {
      const subRequests = parseSubagentContent(sub);
      // Apply parent links from the parent map
      const parentId = parentMap.get(sub.agentId);
      if (parentId) {
        for (const req of subRequests) {
          req.parentRequestId = parentId;
        }
      }
      requests.push(...subRequests);
    }

    // Sort all requests by timestamp
    requests.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Derive title: prefer summary from index, fall back to first user message
  let title: string | null = summary;
  if (!title && firstUserText) {
    title =
      firstUserText.length > 80
        ? firstUserText.slice(0, 80) + "\u2026"
        : firstUserText;
  }

  return {
    sessionId,
    title,
    creationDate: firstTimestamp,
    requests,
    source: "claude",
    provider: "claude",
  };
}

function detectPreloadedSkills(lines: ClaudeLine[]): string[] {
  const skills: string[] = [];
  for (const parsed of lines) {
    if (parsed.type !== "user") continue;
    const blocks = Array.isArray(parsed.message?.content)
      ? parsed.message!.content
      : [];
    for (const block of blocks) {
      if (
        block.type === "text" &&
        block.text &&
        block.text.includes("<skill-format>true</skill-format>")
      ) {
        const match = block.text.match(/<command-name>(.+?)<\/command-name>/);
        if (match) {
          skills.push(match[1]);
        }
      }
    }
  }
  return skills;
}

function parseSubagentContent(sub: SubagentInput): SessionRequest[] {
  if (!sub.content.trim()) return [];

  const lines = sub.content.split("\n").filter((l) => l.trim());
  const agentName =
    sub.subagentType ??
    (sub.agentId.startsWith("acompact-") ? "compact" : "subagent");
  const requests: SessionRequest[] = [];

  // Parse all lines first for preloaded skill detection
  const parsedLines: ClaudeLine[] = [];
  for (const line of lines) {
    try {
      parsedLines.push(JSON.parse(line));
    } catch {
      continue;
    }
  }

  const preloadedSkills = detectPreloadedSkills(parsedLines);

  for (const parsed of parsedLines) {
    // In subagent files, all lines have isSidechain: true
    // We still only want assistant messages
    if (parsed.type === "assistant") {
      const msg = parsed.message;
      if (!msg) continue;

      const toolCalls: ToolCallInfo[] = [];
      const loadedSkills: string[] = [];
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (block.type === "tool_use" && block.id && block.name) {
          toolCalls.push({ id: block.id, name: block.name });
          if (block.name === "Skill" && block.input?.skill) {
            loadedSkills.push(block.input.skill);
          }
        }
      }

      // Attach preloaded skills to the first assistant request
      if (requests.length === 0 && preloadedSkills.length > 0) {
        loadedSkills.push(...preloadedSkills);
      }

      requests.push({
        requestId: String(parsed.uuid ?? ""),
        timestamp: parsed.timestamp
          ? new Date(parsed.timestamp).getTime()
          : 0,
        agentId: "claude-code:subagent",
        customAgentName: agentName,
        modelId: String(msg.model ?? ""),
        messageText: "",
        timings: {
          firstProgress: null,
          totalElapsed: null,
        },
        usage: {
          promptTokens: msg.usage?.input_tokens ?? 0,
          completionTokens: msg.usage?.output_tokens ?? 0,
          cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: msg.usage?.cache_creation_input_tokens ?? 0,
        },
        toolCalls,
        availableSkills: [],
        loadedSkills,
        isSubagent: true,
        subagentId: sub.agentId,
      });
    }
  }

  return requests;
}
