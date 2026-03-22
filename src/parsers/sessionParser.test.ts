import { describe, it, expect } from "vitest";
import { parseSessionJsonl, parseChatReplay } from "./sessionParser.js";

const JSONL_FIXTURE = [
  JSON.stringify({
    kind: 0,
    v: {
      version: 3,
      creationDate: 1770929049693,
      sessionId: "test-session-id",
      requests: [],
    },
  }),
  JSON.stringify({
    kind: 2,
    k: ["requests"],
    v: [
      {
        requestId: "req-1",
        timestamp: 1770929089337,
        agent: {
          id: "github.copilot.editsAgent",
          name: "agent",
        },
        modelId: "copilot/claude-opus-4.6",
        message: { text: "Hello world" },
        response: [],
      },
    ],
  }),
  JSON.stringify({
    kind: 1,
    k: ["requests", 0, "result"],
    v: {
      timings: { firstProgress: 2000, totalElapsed: 5000 },
      metadata: {
        toolCallRounds: [
          {
            toolCalls: [
              { id: "tc-1", name: "read_file" },
              { id: "tc-2", name: "list_dir" },
            ],
          },
        ],
        renderedUserMessage: [
          {
            value:
              'Some text <modeInstructions>\nYou are currently running in "Planner" mode.\n</modeInstructions>\n<skills>\n<skill>\n<name>testing</name>\n<description>Test skill</description>\n<file>/repo/SKILL.md</file>\n</skill>\n</skills>',
          },
        ],
        toolCallResults: {
          "tc-1": {
            content: [{ value: '{"filePath": "/repo/.github/skills/testing/SKILL.md"}' }],
          },
        },
      },
      usage: { promptTokens: 1000, completionTokens: 200 },
    },
  }),
  JSON.stringify({
    kind: 1,
    k: ["customTitle"],
    v: "Test Session Title",
  }),
].join("\n");

describe("parseSessionJsonl", () => {
  it("reconstructs a session from JSONL lines", async () => {
    const session = await parseSessionJsonl(JSONL_FIXTURE);

    expect(session.sessionId).toBe("test-session-id");
    expect(session.title).toBe("Test Session Title");
    expect(session.creationDate).toBe(1770929049693);
    expect(session.source).toBe("jsonl");
    expect(session.provider).toBe("copilot");
    expect(session.requests).toHaveLength(1);
  });

  it("extracts request metadata", async () => {
    const session = await parseSessionJsonl(JSONL_FIXTURE);
    const req = session.requests[0];

    expect(req.requestId).toBe("req-1");
    expect(req.timestamp).toBe(1770929089337);
    expect(req.agentId).toBe("github.copilot.editsAgent");
    expect(req.modelId).toBe("copilot/claude-opus-4.6");
    expect(req.messageText).toBe("Hello world");
  });

  it("extracts timings and usage", async () => {
    const session = await parseSessionJsonl(JSONL_FIXTURE);
    const req = session.requests[0];

    expect(req.timings.firstProgress).toBe(2000);
    expect(req.timings.totalElapsed).toBe(5000);
    expect(req.usage.promptTokens).toBe(1000);
    expect(req.usage.completionTokens).toBe(200);
  });

  it("extracts tool calls", async () => {
    const session = await parseSessionJsonl(JSONL_FIXTURE);
    const req = session.requests[0];

    expect(req.toolCalls).toHaveLength(2);
    expect(req.toolCalls[0].name).toBe("read_file");
    expect(req.toolCalls[1].name).toBe("list_dir");
  });

  it("detects custom agent from modeInstructions", async () => {
    const session = await parseSessionJsonl(JSONL_FIXTURE);
    expect(session.requests[0].customAgentName).toBe("Planner");
  });

  it("detects available skills", async () => {
    const session = await parseSessionJsonl(JSONL_FIXTURE);
    expect(session.requests[0].availableSkills).toHaveLength(1);
    expect(session.requests[0].availableSkills[0].name).toBe("testing");
  });

  it("handles empty JSONL", async () => {
    const session = await parseSessionJsonl("");
    expect(session.sessionId).toBe("unknown");
    expect(session.requests).toEqual([]);
  });

  it("falls back to first user message as title when customTitle is absent", async () => {
    const lines = [
      JSON.stringify({
        kind: 0,
        v: { sessionId: "no-title", creationDate: 0, requests: [] },
      }),
      JSON.stringify({
        kind: 2,
        k: ["requests"],
        v: [
          {
            requestId: "req-1",
            timestamp: 0,
            agent: { id: "github.copilot.editsAgent" },
            modelId: "m1",
            message: { text: "Help me fix the login bug" },
          },
        ],
      }),
    ].join("\n");

    const session = await parseSessionJsonl(lines);
    expect(session.title).toBe("Help me fix the login bug");
  });

  it("truncates long fallback titles to 80 chars", async () => {
    const longMsg = "A".repeat(120);
    const lines = [
      JSON.stringify({
        kind: 0,
        v: { sessionId: "long-title", creationDate: 0, requests: [] },
      }),
      JSON.stringify({
        kind: 2,
        k: ["requests"],
        v: [
          {
            requestId: "req-1",
            timestamp: 0,
            agent: { id: "agent" },
            modelId: "m1",
            message: { text: longMsg },
          },
        ],
      }),
    ].join("\n");

    const session = await parseSessionJsonl(lines);
    expect(session.title).toBe("A".repeat(80) + "\u2026");
  });

  it("detects custom agent from inputState.mode in initial state", async () => {
    const lines = [
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: "s1",
          creationDate: 0,
          requests: [],
          inputState: {
            mode: {
              id: "file:///repo/.github/agents/planner.agent.md",
              kind: "agent",
            },
          },
        },
      }),
      JSON.stringify({
        kind: 2,
        k: ["requests"],
        v: [
          {
            requestId: "req-1",
            timestamp: 0,
            agent: { id: "github.copilot.editsAgent" },
            modelId: "copilot/claude-sonnet-4",
            message: { text: "plan this" },
          },
        ],
      }),
    ].join("\n");

    const session = await parseSessionJsonl(lines);
    expect(session.requests[0].customAgentName).toBe("planner");
  });

  it("tracks mode changes between requests", async () => {
    const lines = [
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: "s2",
          creationDate: 0,
          requests: [],
          inputState: {
            mode: {
              id: "file:///repo/.github/agents/planner.agent.md",
              kind: "agent",
            },
          },
        },
      }),
      JSON.stringify({
        kind: 2,
        k: ["requests"],
        v: [
          {
            requestId: "req-1",
            timestamp: 0,
            agent: { id: "github.copilot.editsAgent" },
            modelId: "m1",
            message: { text: "first" },
          },
        ],
      }),
      // Mode switches to architect
      JSON.stringify({
        kind: 1,
        k: ["inputState", "mode"],
        v: {
          id: "file:///repo/.github/agents/architect.agent.md",
          kind: "agent",
        },
      }),
      JSON.stringify({
        kind: 2,
        k: ["requests"],
        v: [
          {
            requestId: "req-2",
            timestamp: 1,
            agent: { id: "github.copilot.editsAgent" },
            modelId: "m1",
            message: { text: "second" },
          },
        ],
      }),
      // Mode switches to tester
      JSON.stringify({
        kind: 1,
        k: ["inputState", "mode"],
        v: {
          id: "file:///repo/.github/agents/tester.agent.md",
          kind: "agent",
        },
      }),
      JSON.stringify({
        kind: 2,
        k: ["requests"],
        v: [
          {
            requestId: "req-3",
            timestamp: 2,
            agent: { id: "github.copilot.editsAgent" },
            modelId: "m1",
            message: { text: "third" },
          },
        ],
      }),
    ].join("\n");

    const session = await parseSessionJsonl(lines);
    expect(session.requests).toHaveLength(3);
    expect(session.requests[0].customAgentName).toBe("planner");
    expect(session.requests[1].customAgentName).toBe("architect");
    expect(session.requests[2].customAgentName).toBe("tester");
  });

  it("falls back to modeInstructions when no inputState.mode", async () => {
    // The original JSONL_FIXTURE has no inputState.mode but has
    // renderedUserMessage with modeInstructions — should still detect "Planner"
    const session = await parseSessionJsonl(JSONL_FIXTURE);
    expect(session.requests[0].customAgentName).toBe("Planner");
  });
});

// --- runSubagent fixtures ---

const SUBAGENT_FIXTURE = [
  JSON.stringify({
    kind: 0,
    v: {
      sessionId: "subagent-session",
      creationDate: 1770929049693,
      requests: [],
    },
  }),
  // Append a request with runSubagent in toolCallRounds
  JSON.stringify({
    kind: 2,
    k: ["requests"],
    v: [
      {
        requestId: "req-1",
        timestamp: 1770929089337,
        agent: { id: "github.copilot.editsAgent" },
        modelId: "copilot/gpt-5",
        message: { text: "Analyze the agent files" },
        response: [
          // runSubagent parent (first appearance — no result yet)
          {
            kind: "toolInvocationSerialized",
            invocationMessage: "Read all .github agent files",
            isConfirmed: { type: 1 },
            isComplete: true,
            source: { type: "internal", label: "Built-In" },
            toolSpecificData: {
              kind: "subagent",
              description: "Read all .github agent files",
              prompt: "Read ALL files in the .github/agents directory",
            },
            toolCallId: "sa-1",
            toolId: "runSubagent",
          },
          // Child tool calls
          {
            kind: "toolInvocationSerialized",
            invocationMessage: { value: "Listing directory" },
            isConfirmed: { type: 1 },
            isComplete: true,
            source: { type: "internal", label: "Built-In" },
            toolCallId: "child-1",
            toolId: "copilot_listDirectory",
            subAgentInvocationId: "sa-1",
          },
          {
            kind: "toolInvocationSerialized",
            invocationMessage: { value: "Reading file" },
            isConfirmed: { type: 1 },
            isComplete: true,
            source: { type: "internal", label: "Built-In" },
            toolCallId: "child-2",
            toolId: "copilot_readFile",
            subAgentInvocationId: "sa-1",
          },
          {
            kind: "toolInvocationSerialized",
            invocationMessage: { value: "Reading file" },
            isConfirmed: { type: 1 },
            isComplete: true,
            source: { type: "internal", label: "Built-In" },
            toolCallId: "child-3",
            toolId: "copilot_readFile",
            subAgentInvocationId: "sa-1",
          },
          // runSubagent parent (second appearance — with result)
          {
            kind: "toolInvocationSerialized",
            invocationMessage: "Read all .github agent files",
            isConfirmed: { type: 1 },
            isComplete: true,
            source: { type: "internal", label: "Built-In" },
            toolSpecificData: {
              kind: "subagent",
              description: "Read all .github agent files",
              prompt: "Read ALL files in the .github/agents directory",
              result: "Found 3 agent files...",
            },
            toolCallId: "sa-1",
            toolId: "runSubagent",
          },
        ],
      },
    ],
  }),
  // Add toolCallRounds with runSubagent
  JSON.stringify({
    kind: 1,
    k: ["requests", 0, "result"],
    v: {
      timings: { firstProgress: 500, totalElapsed: 8000 },
      metadata: {
        toolCallRounds: [
          {
            toolCalls: [
              { id: "sa-1", name: "runSubagent" },
            ],
          },
        ],
      },
      usage: { promptTokens: 2000, completionTokens: 500 },
    },
  }),
].join("\n");

const MULTI_SUBAGENT_FIXTURE = [
  JSON.stringify({
    kind: 0,
    v: {
      sessionId: "multi-subagent-session",
      creationDate: 1770929049693,
      requests: [],
    },
  }),
  JSON.stringify({
    kind: 2,
    k: ["requests"],
    v: [
      {
        requestId: "req-1",
        timestamp: 1770929089337,
        agent: { id: "github.copilot.editsAgent" },
        modelId: "copilot/gpt-5",
        message: { text: "Full analysis" },
        response: [
          // First subagent
          {
            kind: "toolInvocationSerialized",
            invocationMessage: "Read agent files",
            toolSpecificData: { kind: "subagent", description: "Read agent files" },
            toolCallId: "sa-1",
            toolId: "runSubagent",
          },
          {
            kind: "toolInvocationSerialized",
            toolCallId: "child-1a",
            toolId: "copilot_readFile",
            subAgentInvocationId: "sa-1",
          },
          // Second subagent
          {
            kind: "toolInvocationSerialized",
            invocationMessage: "Read skill files",
            toolSpecificData: { kind: "subagent", description: "Read skill files" },
            toolCallId: "sa-2",
            toolId: "runSubagent",
          },
          {
            kind: "toolInvocationSerialized",
            toolCallId: "child-2a",
            toolId: "copilot_listDirectory",
            subAgentInvocationId: "sa-2",
          },
          {
            kind: "toolInvocationSerialized",
            toolCallId: "child-2b",
            toolId: "copilot_readFile",
            subAgentInvocationId: "sa-2",
          },
        ],
      },
    ],
  }),
  JSON.stringify({
    kind: 1,
    k: ["requests", 0, "result"],
    v: {
      timings: { firstProgress: 500, totalElapsed: 12000 },
      metadata: {
        toolCallRounds: [
          {
            toolCalls: [
              { id: "sa-1", name: "runSubagent" },
              { id: "sa-2", name: "runSubagent" },
            ],
          },
        ],
      },
      usage: { promptTokens: 3000, completionTokens: 800 },
    },
  }),
].join("\n");

describe("parseSessionJsonl — runSubagent", () => {
  it("extracts runSubagent with child tool calls", async () => {
    const session = await parseSessionJsonl(SUBAGENT_FIXTURE);
    const req = session.requests[0];

    expect(req.toolCalls).toHaveLength(1);
    const sa = req.toolCalls[0];
    expect(sa.name).toBe("runSubagent");
    expect(sa.id).toBe("sa-1");
    expect(sa.childToolCalls).toHaveLength(3);
    expect(sa.childToolCalls![0].name).toBe("copilot_listDirectory");
    expect(sa.childToolCalls![1].name).toBe("copilot_readFile");
    expect(sa.childToolCalls![2].name).toBe("copilot_readFile");
  });

  it("sets subagentDescription from response metadata", async () => {
    const session = await parseSessionJsonl(SUBAGENT_FIXTURE);
    const sa = session.requests[0].toolCalls[0];

    expect(sa.subagentDescription).toBe("Read all .github agent files");
  });

  it("groups child tool calls by subAgentInvocationId", async () => {
    const session = await parseSessionJsonl(MULTI_SUBAGENT_FIXTURE);
    const req = session.requests[0];

    expect(req.toolCalls).toHaveLength(2);
    expect(req.toolCalls[0].childToolCalls).toHaveLength(1);
    expect(req.toolCalls[0].subagentDescription).toBe("Read agent files");
    expect(req.toolCalls[1].childToolCalls).toHaveLength(2);
    expect(req.toolCalls[1].subagentDescription).toBe("Read skill files");
  });

  it("handles runSubagent with no children gracefully", async () => {
    const fixture = [
      JSON.stringify({
        kind: 0,
        v: { sessionId: "no-children", creationDate: 0, requests: [] },
      }),
      JSON.stringify({
        kind: 2,
        k: ["requests"],
        v: [
          {
            requestId: "req-1",
            timestamp: 0,
            agent: { id: "github.copilot.editsAgent" },
            modelId: "m1",
            message: { text: "test" },
            response: [
              {
                kind: "toolInvocationSerialized",
                invocationMessage: "Quick check",
                toolSpecificData: { kind: "subagent", description: "Quick check" },
                toolCallId: "sa-lone",
                toolId: "runSubagent",
              },
            ],
          },
        ],
      }),
      JSON.stringify({
        kind: 1,
        k: ["requests", 0, "result"],
        v: {
          metadata: {
            toolCallRounds: [
              { toolCalls: [{ id: "sa-lone", name: "runSubagent" }] },
            ],
          },
          usage: { promptTokens: 100, completionTokens: 50 },
        },
      }),
    ].join("\n");

    const session = await parseSessionJsonl(fixture);
    const sa = session.requests[0].toolCalls[0];
    expect(sa.name).toBe("runSubagent");
    expect(sa.subagentDescription).toBe("Quick check");
    expect(sa.childToolCalls).toEqual([]);
  });
});

// --- MCP tool fixtures ---

const MCP_FIXTURE = [
  JSON.stringify({
    kind: 0,
    v: {
      sessionId: "mcp-session",
      creationDate: 1770929049693,
      requests: [],
    },
  }),
  JSON.stringify({
    kind: 2,
    k: ["requests"],
    v: [
      {
        requestId: "req-1",
        timestamp: 1770929089337,
        agent: { id: "github.copilot.editsAgent" },
        modelId: "copilot/gpt-5",
        message: { text: "Search for pattern" },
        response: [
          // MCP tool from Serena
          {
            kind: "toolInvocationSerialized",
            toolCallId: "tc-1",
            toolId: "mcp_serena_search_for_pattern",
            source: {
              type: "mcp",
              serverLabel: "FastMCP",
              label: "serena",
              collectionId: "mcp.config.ws0",
              definitionId: "mcp.config.ws0.serena",
            },
          },
          // Another Serena tool
          {
            kind: "toolInvocationSerialized",
            toolCallId: "tc-2",
            toolId: "mcp_serena_find_symbol",
            source: {
              type: "mcp",
              serverLabel: "FastMCP",
              label: "serena",
              collectionId: "mcp.config.ws0",
              definitionId: "mcp.config.ws0.serena",
            },
          },
          // Built-in tool
          {
            kind: "toolInvocationSerialized",
            toolCallId: "tc-3",
            toolId: "read_file",
            source: {
              type: "internal",
              label: "Built-In",
            },
          },
          // MCP tool from GitKraken
          {
            kind: "toolInvocationSerialized",
            toolCallId: "tc-4",
            toolId: "mcp_gitkraken_bun_git_status",
            source: {
              type: "mcp",
              serverLabel: "GitKraken CLI",
              label: "GitKraken (bundled with GitLens)",
              collectionId: "eamodio.gitlens/gkMcpProvider",
              definitionId: "eamodio.gitlens/GitKraken",
            },
          },
        ],
      },
    ],
  }),
  JSON.stringify({
    kind: 1,
    k: ["requests", 0, "result"],
    v: {
      timings: { firstProgress: 500, totalElapsed: 3000 },
      metadata: {
        toolCallRounds: [
          {
            toolCalls: [
              { id: "round-tc-1", name: "mcp_serena_search_for_pattern" },
              { id: "round-tc-2", name: "mcp_serena_find_symbol" },
              { id: "round-tc-3", name: "read_file" },
              { id: "round-tc-4", name: "mcp_gitkraken_bun_git_status" },
            ],
          },
        ],
      },
      usage: { promptTokens: 2000, completionTokens: 500 },
    },
  }),
].join("\n");

const MCP_SUBAGENT_FIXTURE = [
  JSON.stringify({
    kind: 0,
    v: {
      sessionId: "mcp-subagent-session",
      creationDate: 1770929049693,
      requests: [],
    },
  }),
  JSON.stringify({
    kind: 2,
    k: ["requests"],
    v: [
      {
        requestId: "req-1",
        timestamp: 1770929089337,
        agent: { id: "github.copilot.editsAgent" },
        modelId: "copilot/gpt-5",
        message: { text: "Analyze with subagent" },
        response: [
          // runSubagent parent
          {
            kind: "toolInvocationSerialized",
            toolCallId: "sa-1",
            toolId: "runSubagent",
            toolSpecificData: { kind: "subagent", description: "Search code" },
          },
          // MCP child tool inside subagent
          {
            kind: "toolInvocationSerialized",
            toolCallId: "child-1",
            toolId: "mcp_serena_search_for_pattern",
            subAgentInvocationId: "sa-1",
            source: {
              type: "mcp",
              serverLabel: "FastMCP",
              label: "serena",
            },
          },
          // Built-in child tool inside subagent
          {
            kind: "toolInvocationSerialized",
            toolCallId: "child-2",
            toolId: "copilot_readFile",
            subAgentInvocationId: "sa-1",
            source: {
              type: "internal",
              label: "Built-In",
            },
          },
        ],
      },
    ],
  }),
  JSON.stringify({
    kind: 1,
    k: ["requests", 0, "result"],
    v: {
      metadata: {
        toolCallRounds: [
          { toolCalls: [{ id: "round-sa-1", name: "runSubagent" }] },
        ],
      },
      usage: { promptTokens: 1000, completionTokens: 200 },
    },
  }),
].join("\n");

describe("parseSessionJsonl — MCP tools", () => {
  it("extracts mcpServer from response source field", async () => {
    const session = await parseSessionJsonl(MCP_FIXTURE);
    const req = session.requests[0];
    const serena = req.toolCalls.find(
      (t) => t.name === "mcp_serena_search_for_pattern",
    );
    expect(serena?.mcpServer).toBe("FastMCP");
  });

  it("sets mcpServer on all matching tools by name", async () => {
    const session = await parseSessionJsonl(MCP_FIXTURE);
    const req = session.requests[0];
    const gitkraken = req.toolCalls.find(
      (t) => t.name === "mcp_gitkraken_bun_git_status",
    );
    expect(gitkraken?.mcpServer).toBe("GitKraken CLI");

    const findSymbol = req.toolCalls.find(
      (t) => t.name === "mcp_serena_find_symbol",
    );
    expect(findSymbol?.mcpServer).toBe("FastMCP");
  });

  it("does not set mcpServer on built-in tools", async () => {
    const session = await parseSessionJsonl(MCP_FIXTURE);
    const req = session.requests[0];
    const readFile = req.toolCalls.find((t) => t.name === "read_file");
    expect(readFile?.mcpServer).toBeUndefined();
  });

  it("sets mcpServer on subagent child tool calls", async () => {
    const session = await parseSessionJsonl(MCP_SUBAGENT_FIXTURE);
    const req = session.requests[0];
    const sa = req.toolCalls.find((t) => t.name === "runSubagent");
    expect(sa?.childToolCalls).toHaveLength(2);

    const mcpChild = sa!.childToolCalls!.find(
      (c) => c.name === "mcp_serena_search_for_pattern",
    );
    expect(mcpChild?.mcpServer).toBe("FastMCP");

    const builtinChild = sa!.childToolCalls!.find(
      (c) => c.name === "copilot_readFile",
    );
    expect(builtinChild?.mcpServer).toBeUndefined();
  });
});

const CHATREPLAY_FIXTURE = JSON.stringify({
  exportedAt: "2026-02-12T21:13:03.592Z",
  totalPrompts: 1,
  totalLogEntries: 2,
  prompts: [
    {
      prompt: "Hello from chatreplay",
      promptId: "prompt-1",
      logs: [
        {
          id: "log-1",
          kind: "request",
          type: "ChatMLSuccess",
          name: "panel/editAgent",
          metadata: {
            model: "claude-opus-4.6",
            duration: 5000,
            timeToFirstToken: 2000,
            startTime: "2026-02-12T21:04:30.522Z",
            endTime: "2026-02-12T21:04:35.379Z",
            usage: { prompt_tokens: 1500, completion_tokens: 300 },
          },
          requestMessages: {
            messages: [
              {
                role: "system",
                content:
                  '<modeInstructions>\nYou are currently running in "Reviewer" mode.\n</modeInstructions>',
              },
            ],
          },
          response: { type: "success", message: ["Response text"] },
        },
        {
          id: "tool-1",
          kind: "toolCall",
          tool: "read_file",
          args: '{"filePath": "/repo/.github/skills/testing/SKILL.md"}',
          time: "2026-02-12T21:04:35.000Z",
          response: ["file contents"],
        },
      ],
    },
  ],
});

describe("parseChatReplay", () => {
  it("parses a chatreplay export", async () => {
    const session = parseChatReplay(CHATREPLAY_FIXTURE);

    expect(session.source).toBe("chatreplay");
    expect(session.provider).toBe("copilot");
    expect(session.requests).toHaveLength(1);
  });

  it("extracts request data from chatreplay", async () => {
    const session = parseChatReplay(CHATREPLAY_FIXTURE);
    const req = session.requests[0];

    expect(req.messageText).toBe("Hello from chatreplay");
    expect(req.modelId).toBe("claude-opus-4.6");
    expect(req.timings.totalElapsed).toBe(5000);
    expect(req.timings.firstProgress).toBe(2000);
    expect(req.usage.promptTokens).toBe(1500);
    expect(req.usage.completionTokens).toBe(300);
  });

  it("detects custom agent from chatreplay", async () => {
    const session = parseChatReplay(CHATREPLAY_FIXTURE);
    expect(session.requests[0].customAgentName).toBe("Reviewer");
  });

  it("detects loaded skills from tool calls", async () => {
    const session = parseChatReplay(CHATREPLAY_FIXTURE);
    expect(session.requests[0].loadedSkills).toContain("testing");
  });
});
