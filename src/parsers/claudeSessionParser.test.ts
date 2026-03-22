import { describe, it, expect } from "vitest";
import {
  parseClaudeSessionJsonl,
  buildSubagentTypeMap,
} from "./claudeSessionParser.js";

function userLine(text: string, uuid: string): string {
  return JSON.stringify({
    type: "user",
    sessionId: "sess-1",
    uuid,
    parentUuid: null,
    isSidechain: false,
    timestamp: "2026-02-14T10:00:00.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  });
}

function assistantLine(opts: {
  uuid: string;
  parentUuid: string;
  model?: string;
  content?: unknown[];
  usage?: Record<string, number>;
  isSidechain?: boolean;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "sess-1",
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    isSidechain: opts.isSidechain ?? false,
    timestamp: opts.timestamp ?? "2026-02-14T10:00:01.000Z",
    message: {
      model: opts.model ?? "claude-opus-4-6",
      role: "assistant",
      content: opts.content ?? [{ type: "text", text: "Hello" }],
      usage: {
        input_tokens: opts.usage?.input_tokens ?? 100,
        output_tokens: opts.usage?.output_tokens ?? 50,
        cache_read_input_tokens: opts.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens:
          opts.usage?.cache_creation_input_tokens ?? 0,
      },
    },
  });
}

function progressLine(): string {
  return JSON.stringify({
    type: "progress",
    sessionId: "sess-1",
    uuid: "prog-1",
    data: { type: "hook_progress" },
    timestamp: "2026-02-14T10:00:00.500Z",
  });
}

const BASIC_SESSION = [
  userLine("Hello world", "u1"),
  assistantLine({ uuid: "a1", parentUuid: "u1" }),
].join("\n");

describe("parseClaudeSessionJsonl", () => {
  it("parses a basic session with one exchange", async () => {
    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null);

    expect(session.sessionId).toBe("sess-1");
    expect(session.source).toBe("claude");
    expect(session.provider).toBe("claude");
    expect(session.requests).toHaveLength(1);
  });

  it("uses summary as title when provided", async () => {
    const session = await parseClaudeSessionJsonl(BASIC_SESSION, "My Summary");
    expect(session.title).toBe("My Summary");
  });

  it("derives title from first user message when no summary", async () => {
    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null);
    expect(session.title).toBe("Hello world");
  });

  it("truncates long first-message titles to 80 characters", async () => {
    const longMessage = "A".repeat(100);
    const lines = [
      userLine(longMessage, "u1"),
      assistantLine({ uuid: "a1", parentUuid: "u1" }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.title).toBe("A".repeat(80) + "\u2026");
  });

  it("skips system-injected tags when deriving title", async () => {
    const lines = [
      JSON.stringify({
        type: "user",
        sessionId: "sess-1",
        uuid: "u1",
        parentUuid: null,
        isSidechain: false,
        timestamp: "2026-02-14T10:00:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "<ide_opened_file>The user opened the file /foo/bar.ts</ide_opened_file>",
            },
            {
              type: "text",
              text: "let's fix the bug in the parser",
            },
          ],
        },
      }),
      assistantLine({ uuid: "a1", parentUuid: "u1" }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.title).toBe("let's fix the bug in the parser");
  });

  it("falls back to null title when no summary and no user messages", async () => {
    const lines = [
      assistantLine({ uuid: "a1", parentUuid: "u1" }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.title).toBeNull();
  });

  it("sets creationDate from first message timestamp", async () => {
    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null);
    expect(session.creationDate).toBe(
      new Date("2026-02-14T10:00:00.000Z").getTime(),
    );
  });

  it("extracts request metadata", async () => {
    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null);
    const req = session.requests[0];

    expect(req.requestId).toBe("a1");
    expect(req.modelId).toBe("claude-opus-4-6");
    expect(req.agentId).toBe("claude-code");
    expect(req.messageText).toBe("Hello world");
    expect(req.timestamp).toBe(
      new Date("2026-02-14T10:00:01.000Z").getTime(),
    );
  });

  it("extracts token usage", async () => {
    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null);
    const req = session.requests[0];

    expect(req.usage.promptTokens).toBe(100);
    expect(req.usage.completionTokens).toBe(50);
  });

  it("extracts tool calls from content blocks", async () => {
    const content = [
      { type: "text", text: "Let me read that file." },
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
      { type: "tool_use", id: "toolu_2", name: "Grep", input: {} },
    ];

    const lines = [
      userLine("check the code", "u1"),
      assistantLine({ uuid: "a1", parentUuid: "u1", content }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.requests[0].toolCalls).toHaveLength(2);
    expect(session.requests[0].toolCalls[0]).toEqual({
      id: "toolu_1",
      name: "Read",
    });
    expect(session.requests[0].toolCalls[1]).toEqual({
      id: "toolu_2",
      name: "Grep",
    });
  });

  it("aggregates multiple assistant messages into one request per user turn", async () => {
    // Claude often sends multiple assistant lines for a single response
    // (text, then tool_use, then more text after tool_result)
    // We treat each assistant line as a separate request
    const lines = [
      userLine("do something", "u1"),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        content: [{ type: "text", text: "thinking..." }],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      assistantLine({
        uuid: "a2",
        parentUuid: "a1",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
        usage: { input_tokens: 200, output_tokens: 30 },
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.requests).toHaveLength(2);
    expect(session.requests[0].usage.promptTokens).toBe(100);
    expect(session.requests[0].messageText).toBe("do something");
    expect(session.requests[1].toolCalls).toHaveLength(1);
    expect(session.requests[1].messageText).toBe("");
  });

  it("skips sidechain (subagent) messages", async () => {
    const lines = [
      userLine("hello", "u1"),
      assistantLine({ uuid: "a1", parentUuid: "u1" }),
      assistantLine({
        uuid: "a2",
        parentUuid: "u1",
        isSidechain: true,
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.requests).toHaveLength(1);
  });

  it("skips progress and other non-message lines", async () => {
    const lines = [
      userLine("hi", "u1"),
      progressLine(),
      assistantLine({ uuid: "a1", parentUuid: "u1" }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.requests).toHaveLength(1);
  });

  it("handles empty content", async () => {
    const session = await parseClaudeSessionJsonl("", null);
    expect(session.sessionId).toBe("unknown");
    expect(session.requests).toEqual([]);
  });

  it("handles malformed lines gracefully", async () => {
    const lines = [
      "not json at all",
      userLine("hello", "u1"),
      "{ broken json",
      assistantLine({ uuid: "a1", parentUuid: "u1" }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.requests).toHaveLength(1);
  });

  it("handles multiple user-assistant exchanges", async () => {
    const lines = [
      userLine("first question", "u1"),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-02-14T10:00:01.000Z",
      }),
      userLine("second question", "u2"),
      assistantLine({
        uuid: "a2",
        parentUuid: "u2",
        timestamp: "2026-02-14T10:01:00.000Z",
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.requests).toHaveLength(2);
    expect(session.requests[0].messageText).toBe("first question");
    expect(session.requests[1].messageText).toBe("second question");
  });

  it("sets empty skills when no Skill tool is used", async () => {
    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null);
    const req = session.requests[0];

    expect(req.customAgentName).toBeNull();
    expect(req.availableSkills).toEqual([]);
    expect(req.loadedSkills).toEqual([]);
  });

  it("detects loaded skills from Skill tool_use blocks", async () => {
    const lines = [
      userLine("fix bug 48", "u1"),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        content: [
          { type: "text", text: "Let me invoke the bugfix skill." },
          { type: "tool_use", id: "toolu_skill_1", name: "Skill", input: { skill: "bugfix", args: "48" } },
        ],
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.requests[0].loadedSkills).toEqual(["bugfix"]);
  });

  it("detects multiple skills in a single request", async () => {
    const lines = [
      userLine("help me test", "u1"),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        content: [
          { type: "tool_use", id: "s1", name: "Skill", input: { skill: "testing" } },
          { type: "tool_use", id: "s2", name: "Skill", input: { skill: "vscode-extensions" } },
        ],
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.requests[0].loadedSkills).toEqual(["testing", "vscode-extensions"]);
  });

  it("does not count non-Skill tool_use blocks as skills", async () => {
    const lines = [
      userLine("read a file", "u1"),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/foo.ts" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.requests[0].loadedSkills).toEqual([]);
  });

  it("sets timings to null (not available in Claude format)", async () => {
    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null);
    const req = session.requests[0];

    expect(req.timings.firstProgress).toBeNull();
    expect(req.timings.totalElapsed).toBeNull();
  });

  it("extracts cache token usage", async () => {
    const lines = [
      userLine("hello", "u1"),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        usage: {
          input_tokens: 3,
          output_tokens: 10,
          cache_read_input_tokens: 18019,
          cache_creation_input_tokens: 2620,
        },
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    const req = session.requests[0];

    expect(req.usage.promptTokens).toBe(3);
    expect(req.usage.completionTokens).toBe(10);
    expect(req.usage.cacheReadTokens).toBe(18019);
    expect(req.usage.cacheCreationTokens).toBe(2620);
  });

  it("defaults cache tokens to 0 when not present", async () => {
    const lines = [
      userLine("hello", "u1"),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    const req = session.requests[0];

    expect(req.usage.cacheReadTokens).toBe(0);
    expect(req.usage.cacheCreationTokens).toBe(0);
  });

  it("handles string content gracefully", async () => {
    const lines = [
      JSON.stringify({
        type: "user",
        sessionId: "sess-1",
        uuid: "u1",
        timestamp: "2026-02-14T10:00:00.000Z",
        message: { role: "user", content: "plain string content" },
      }),
      assistantLine({ uuid: "a1", parentUuid: "u1" }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(lines, null);
    expect(session.requests).toHaveLength(1);
    expect(session.requests[0].messageText).toBe("plain string content");
  });
});

// --- Subagent helpers ---

function taskToolUseLine(opts: {
  uuid: string;
  parentUuid: string;
  toolId: string;
  subagentType: string;
  description: string;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "sess-1",
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    isSidechain: false,
    timestamp: opts.timestamp ?? "2026-02-14T10:00:02.000Z",
    message: {
      model: "claude-opus-4-6",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: opts.toolId,
          name: "Task",
          input: {
            description: opts.description,
            subagent_type: opts.subagentType,
            prompt: "do something",
          },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 10 },
    },
  });
}

function taskToolResultLine(opts: {
  uuid: string;
  parentUuid: string;
  toolUseId: string;
  agentId: string;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: "user",
    sessionId: "sess-1",
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    isSidechain: false,
    timestamp: opts.timestamp ?? "2026-02-14T10:00:05.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: opts.toolUseId,
          content: [
            {
              type: "text",
              text: `Result text here\nagentId: ${opts.agentId} (for resuming to continue this agent's work if needed)`,
            },
          ],
        },
      ],
    },
  });
}

function subagentUserLine(opts: {
  uuid: string;
  agentId: string;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: "user",
    sessionId: "sess-1",
    uuid: opts.uuid,
    parentUuid: null,
    isSidechain: true,
    agentId: opts.agentId,
    timestamp: opts.timestamp ?? "2026-02-14T10:00:03.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "subagent prompt" }],
    },
  });
}

function subagentAssistantLine(opts: {
  uuid: string;
  parentUuid: string;
  agentId: string;
  model?: string;
  content?: unknown[];
  usage?: Record<string, number>;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "sess-1",
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    isSidechain: true,
    agentId: opts.agentId,
    timestamp: opts.timestamp ?? "2026-02-14T10:00:04.000Z",
    message: {
      model: opts.model ?? "claude-opus-4-6",
      role: "assistant",
      content: opts.content ?? [{ type: "text", text: "subagent response" }],
      usage: {
        input_tokens: opts.usage?.input_tokens ?? 200,
        output_tokens: opts.usage?.output_tokens ?? 80,
        cache_read_input_tokens: opts.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens:
          opts.usage?.cache_creation_input_tokens ?? 0,
      },
    },
  });
}

describe("buildSubagentTypeMap", () => {
  it("extracts agentId to subagentType mapping from Task tool calls", async () => {
    const lines = [
      userLine("do something", "u1"),
      taskToolUseLine({
        uuid: "a1",
        parentUuid: "u1",
        toolId: "toolu_1",
        subagentType: "Explore",
        description: "find files",
      }),
      taskToolResultLine({
        uuid: "u2",
        parentUuid: "a1",
        toolUseId: "toolu_1",
        agentId: "abc123",
      }),
    ].join("\n");

    const map = buildSubagentTypeMap(lines);
    expect(map.get("abc123")).toBe("Explore");
  });

  it("extracts agentId to subagentType mapping from Agent tool calls (renamed from Task)", async () => {
    const agentToolUseLine = JSON.stringify({
      type: "assistant",
      sessionId: "sess-1",
      uuid: "a1",
      parentUuid: "u1",
      isSidechain: false,
      timestamp: "2026-02-14T10:00:02.000Z",
      message: {
        model: "claude-opus-4-6",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Agent",
            input: {
              description: "explore the code",
              subagent_type: "Explore",
              prompt: "find the parser files",
            },
          },
        ],
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    });

    const lines = [
      userLine("do something", "u1"),
      agentToolUseLine,
      taskToolResultLine({
        uuid: "u2",
        parentUuid: "a1",
        toolUseId: "toolu_1",
        agentId: "abc123",
      }),
    ].join("\n");

    const map = buildSubagentTypeMap(lines);
    expect(map.get("abc123")).toBe("Explore");
  });

  it("returns empty map when no Task tool calls", async () => {
    const map = buildSubagentTypeMap(BASIC_SESSION);
    expect(map.size).toBe(0);
  });

  it("handles multiple Task invocations", async () => {
    const lines = [
      userLine("start", "u1"),
      taskToolUseLine({
        uuid: "a1",
        parentUuid: "u1",
        toolId: "toolu_1",
        subagentType: "Bash",
        description: "run command",
      }),
      taskToolResultLine({
        uuid: "u2",
        parentUuid: "a1",
        toolUseId: "toolu_1",
        agentId: "abc123",
      }),
      taskToolUseLine({
        uuid: "a2",
        parentUuid: "u2",
        toolId: "toolu_2",
        subagentType: "Plan",
        description: "design plan",
      }),
      taskToolResultLine({
        uuid: "u3",
        parentUuid: "a2",
        toolUseId: "toolu_2",
        agentId: "def456",
      }),
    ].join("\n");

    const map = buildSubagentTypeMap(lines);
    expect(map.get("abc123")).toBe("Bash");
    expect(map.get("def456")).toBe("Plan");
  });

  it("handles missing agentId in tool_result gracefully", async () => {
    const lines = [
      userLine("start", "u1"),
      taskToolUseLine({
        uuid: "a1",
        parentUuid: "u1",
        toolId: "toolu_1",
        subagentType: "Explore",
        description: "find files",
      }),
      // tool_result without agentId pattern
      JSON.stringify({
        type: "user",
        sessionId: "sess-1",
        uuid: "u2",
        parentUuid: "a1",
        isSidechain: false,
        timestamp: "2026-02-14T10:00:05.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "error: tool failed",
            },
          ],
        },
      }),
    ].join("\n");

    const map = buildSubagentTypeMap(lines);
    expect(map.size).toBe(0);
  });

  it("uses last agentId match when tool_result contains multiple references", async () => {
    // Simulate a tool_result where the Explore agent's output mentions
    // other agent files, but the real agentId is appended at the end
    const toolResultWithMultipleAgentIds = JSON.stringify({
      type: "user",
      sessionId: "sess-1",
      uuid: "u2",
      parentUuid: "a1",
      isSidechain: false,
      timestamp: "2026-02-14T10:00:05.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              {
                type: "text",
                text: [
                  "Found subagent files:",
                  "agent-a605be3.jsonl",
                  "agentId: a605be3 (for resuming to continue this agent's work if needed)",
                  "More output here...",
                ].join("\n"),
              },
              {
                type: "text",
                text: "agentId: abf0a0e (for resuming to continue this agent's work if needed)\n<usage>total_tokens: 38642</usage>",
              },
            ],
          },
        ],
      },
    });

    const lines = [
      userLine("start", "u1"),
      taskToolUseLine({
        uuid: "a1",
        parentUuid: "u1",
        toolId: "toolu_1",
        subagentType: "Explore",
        description: "find files",
      }),
      toolResultWithMultipleAgentIds,
    ].join("\n");

    const map = buildSubagentTypeMap(lines);
    expect(map.get("abf0a0e")).toBe("Explore");
    // Should NOT map the wrong agentId
    expect(map.has("a605be3")).toBe(false);
  });

  it("handles agentIds with hyphens", async () => {
    const lines = [
      userLine("start", "u1"),
      taskToolUseLine({
        uuid: "a1",
        parentUuid: "u1",
        toolId: "toolu_1",
        subagentType: "Bash",
        description: "run cmd",
      }),
      taskToolResultLine({
        uuid: "u2",
        parentUuid: "a1",
        toolUseId: "toolu_1",
        agentId: "acompact-b8acf4",
      }),
    ].join("\n");

    const map = buildSubagentTypeMap(lines);
    expect(map.get("acompact-b8acf4")).toBe("Bash");
  });
});

describe("subagent parsing", () => {
  it("includes subagent requests when subagent input provided", async () => {
    const mainContent = BASIC_SESSION;
    const subContent = [
      subagentUserLine({ uuid: "su1", agentId: "abc123" }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su1",
        agentId: "abc123",
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(mainContent, null, [
      { content: subContent, agentId: "abc123", subagentType: "Explore" },
    ]);

    expect(session.requests).toHaveLength(2); // 1 main + 1 subagent
  });

  it("sets isSubagent true on subagent requests", async () => {
    const subContent = [
      subagentUserLine({ uuid: "su1", agentId: "abc123" }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su1",
        agentId: "abc123",
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null, [
      { content: subContent, agentId: "abc123", subagentType: "Explore" },
    ]);

    const mainReq = session.requests.find((r) => !r.isSubagent);
    const subReq = session.requests.find((r) => r.isSubagent);

    expect(mainReq).toBeDefined();
    expect(mainReq!.isSubagent).toBeFalsy();
    expect(subReq).toBeDefined();
    expect(subReq!.isSubagent).toBe(true);
  });

  it("sets customAgentName from subagentType", async () => {
    const subContent = [
      subagentUserLine({ uuid: "su1", agentId: "abc123" }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su1",
        agentId: "abc123",
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null, [
      { content: subContent, agentId: "abc123", subagentType: "Explore" },
    ]);

    const subReq = session.requests.find((r) => r.isSubagent);
    expect(subReq!.customAgentName).toBe("Explore");
    expect(subReq!.agentId).toBe("claude-code:subagent");
  });

  it("falls back to agentId when subagentType is null", async () => {
    const subContent = [
      subagentUserLine({ uuid: "su1", agentId: "abc123" }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su1",
        agentId: "abc123",
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null, [
      { content: subContent, agentId: "abc123", subagentType: null },
    ]);

    const subReq = session.requests.find((r) => r.isSubagent);
    expect(subReq!.customAgentName).toBe("subagent");
  });

  it("labels acompact-* agents as 'compact' when subagentType is null", async () => {
    const subContent = [
      subagentUserLine({ uuid: "su1", agentId: "acompact-b8acf4" }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su1",
        agentId: "acompact-b8acf4",
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null, [
      { content: subContent, agentId: "acompact-b8acf4", subagentType: null },
    ]);

    const subReq = session.requests.find((r) => r.isSubagent);
    expect(subReq!.customAgentName).toBe("compact");
  });

  it("interleaves subagent requests by timestamp", async () => {
    const mainContent = [
      userLine("first", "u1"),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-02-14T10:00:01.000Z",
      }),
      userLine("second", "u2"),
      assistantLine({
        uuid: "a2",
        parentUuid: "u2",
        timestamp: "2026-02-14T10:00:10.000Z",
      }),
    ].join("\n");

    const subContent = [
      subagentUserLine({
        uuid: "su1",
        agentId: "abc123",
        timestamp: "2026-02-14T10:00:05.000Z",
      }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su1",
        agentId: "abc123",
        timestamp: "2026-02-14T10:00:06.000Z",
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(mainContent, null, [
      { content: subContent, agentId: "abc123", subagentType: "Bash" },
    ]);

    expect(session.requests).toHaveLength(3);
    expect(session.requests[0].timestamp).toBe(
      new Date("2026-02-14T10:00:01.000Z").getTime(),
    );
    expect(session.requests[1].isSubagent).toBe(true);
    expect(session.requests[1].timestamp).toBe(
      new Date("2026-02-14T10:00:06.000Z").getTime(),
    );
    expect(session.requests[2].timestamp).toBe(
      new Date("2026-02-14T10:00:10.000Z").getTime(),
    );
  });

  it("extracts tool calls from subagent content", async () => {
    const subContent = [
      subagentUserLine({ uuid: "su1", agentId: "abc123" }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su1",
        agentId: "abc123",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Grep", input: {} },
        ],
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null, [
      { content: subContent, agentId: "abc123", subagentType: "Explore" },
    ]);

    const subReq = session.requests.find((r) => r.isSubagent);
    expect(subReq!.toolCalls).toHaveLength(2);
    expect(subReq!.toolCalls[0]).toEqual({ id: "t1", name: "Read" });
  });

  it("extracts token usage from subagent content", async () => {
    const subContent = [
      subagentUserLine({ uuid: "su1", agentId: "abc123" }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su1",
        agentId: "abc123",
        usage: {
          input_tokens: 5,
          output_tokens: 20,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 1000,
        },
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null, [
      { content: subContent, agentId: "abc123", subagentType: "Explore" },
    ]);

    const subReq = session.requests.find((r) => r.isSubagent);
    expect(subReq!.usage.promptTokens).toBe(5);
    expect(subReq!.usage.completionTokens).toBe(20);
    expect(subReq!.usage.cacheReadTokens).toBe(5000);
    expect(subReq!.usage.cacheCreationTokens).toBe(1000);
  });

  it("sets subagentId on subagent requests", async () => {
    const subContent = [
      subagentUserLine({ uuid: "su1", agentId: "abc123" }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su1",
        agentId: "abc123",
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null, [
      { content: subContent, agentId: "abc123", subagentType: "Explore" },
    ]);

    const subReq = session.requests.find((r) => r.isSubagent);
    expect(subReq!.subagentId).toBe("abc123");
  });

  it("sets parentRequestId linking subagent to spawning main request", async () => {
    // Main session: user asks → assistant spawns Agent tool → tool_result returns agentId
    const mainContent = [
      userLine("do something", "u1"),
      taskToolUseLine({
        uuid: "a1",
        parentUuid: "u1",
        toolId: "toolu_1",
        subagentType: "Explore",
        description: "find files",
        timestamp: "2026-02-14T10:00:01.000Z",
      }),
      taskToolResultLine({
        uuid: "u2",
        parentUuid: "a1",
        toolUseId: "toolu_1",
        agentId: "abc123",
        timestamp: "2026-02-14T10:00:05.000Z",
      }),
    ].join("\n");

    const subContent = [
      subagentUserLine({
        uuid: "su1",
        agentId: "abc123",
        timestamp: "2026-02-14T10:00:02.000Z",
      }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su1",
        agentId: "abc123",
        timestamp: "2026-02-14T10:00:03.000Z",
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(mainContent, null, [
      { content: subContent, agentId: "abc123", subagentType: "Explore" },
    ]);

    const subReq = session.requests.find((r) => r.isSubagent);
    // parentRequestId should be "a1" — the assistant message that made the Agent tool call
    expect(subReq!.parentRequestId).toBe("a1");
  });

  it("links multiple subagents to their respective parent requests", async () => {
    const mainContent = [
      userLine("start", "u1"),
      taskToolUseLine({
        uuid: "a1",
        parentUuid: "u1",
        toolId: "toolu_1",
        subagentType: "Explore",
        description: "find files",
        timestamp: "2026-02-14T10:00:01.000Z",
      }),
      taskToolResultLine({
        uuid: "u2",
        parentUuid: "a1",
        toolUseId: "toolu_1",
        agentId: "abc123",
        timestamp: "2026-02-14T10:00:04.000Z",
      }),
      taskToolUseLine({
        uuid: "a2",
        parentUuid: "u2",
        toolId: "toolu_2",
        subagentType: "Plan",
        description: "design plan",
        timestamp: "2026-02-14T10:00:05.000Z",
      }),
      taskToolResultLine({
        uuid: "u3",
        parentUuid: "a2",
        toolUseId: "toolu_2",
        agentId: "def456",
        timestamp: "2026-02-14T10:00:09.000Z",
      }),
    ].join("\n");

    const subContent1 = [
      subagentUserLine({
        uuid: "su1",
        agentId: "abc123",
        timestamp: "2026-02-14T10:00:02.000Z",
      }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su1",
        agentId: "abc123",
        timestamp: "2026-02-14T10:00:03.000Z",
      }),
    ].join("\n");

    const subContent2 = [
      subagentUserLine({
        uuid: "su2",
        agentId: "def456",
        timestamp: "2026-02-14T10:00:06.000Z",
      }),
      subagentAssistantLine({
        uuid: "sa2",
        parentUuid: "su2",
        agentId: "def456",
        timestamp: "2026-02-14T10:00:07.000Z",
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(mainContent, null, [
      { content: subContent1, agentId: "abc123", subagentType: "Explore" },
      { content: subContent2, agentId: "def456", subagentType: "Plan" },
    ]);

    const exploreReq = session.requests.find(
      (r) => r.isSubagent && r.customAgentName === "Explore",
    );
    const planReq = session.requests.find(
      (r) => r.isSubagent && r.customAgentName === "Plan",
    );

    expect(exploreReq!.parentRequestId).toBe("a1");
    expect(planReq!.parentRequestId).toBe("a2");
  });

  it("detects preloaded skills from skill-format tags in subagent user messages", async () => {
    const subContent = [
      // Task prompt
      JSON.stringify({
        type: "user",
        sessionId: "sess-1",
        uuid: "su1",
        parentUuid: null,
        isSidechain: true,
        timestamp: "2026-02-14T10:00:03.000Z",
        message: {
          role: "user",
          content: "implement the feature",
        },
      }),
      // Preloaded skills injected as user message
      JSON.stringify({
        type: "user",
        sessionId: "sess-1",
        uuid: "su2",
        parentUuid: "su1",
        isSidechain: true,
        timestamp: "2026-02-14T10:00:03.100Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "<command-message>project-context</command-message>\n<command-name>project-context</command-name>\n<skill-format>true</skill-format>",
            },
            {
              type: "text",
              text: "Base directory for this skill: /path/.claude/skills/project-context\n\n# Agent Lens -- Project Architecture",
            },
            {
              type: "text",
              text: "<command-message>testing</command-message>\n<command-name>testing</command-name>\n<skill-format>true</skill-format>",
            },
            {
              type: "text",
              text: "Base directory for this skill: /path/.claude/skills/testing\n\n# Testing Guide",
            },
          ],
        },
      }),
      subagentAssistantLine({
        uuid: "sa1",
        parentUuid: "su2",
        agentId: "abc123",
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null, [
      { content: subContent, agentId: "abc123", subagentType: "Implementer" },
    ]);

    const subReq = session.requests.find((r) => r.isSubagent);
    expect(subReq!.loadedSkills).toContain("project-context");
    expect(subReq!.loadedSkills).toContain("testing");
  });

  it("handles empty subagent content gracefully", async () => {
    const session = await parseClaudeSessionJsonl(BASIC_SESSION, null, [
      { content: "", agentId: "abc123", subagentType: "Explore" },
    ]);

    // Only main session requests, no subagent requests added
    expect(session.requests).toHaveLength(1);
    expect(session.requests[0].isSubagent).toBeFalsy();
  });

  it("still skips isSidechain lines in main session content", async () => {
    const mainContent = [
      userLine("hello", "u1"),
      assistantLine({ uuid: "a1", parentUuid: "u1" }),
      assistantLine({
        uuid: "a2",
        parentUuid: "u1",
        isSidechain: true,
      }),
    ].join("\n");

    const session = await parseClaudeSessionJsonl(mainContent, null);
    expect(session.requests).toHaveLength(1);
  });
});
