import { describe, it, expect } from "vitest";
import {
  computeTimelineLayout,
  computeMinimapViewport,
  type SessionRequestLike,
} from "./timelineLayout.js";

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makeReq(
  overrides: Partial<SessionRequestLike> & {
    requestId: string;
    timestamp: number;
  },
): SessionRequestLike {
  return {
    agentId: "claude-code",
    customAgentName: null,
    usage: { promptTokens: 100, completionTokens: 50 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — computeTimelineLayout
// ---------------------------------------------------------------------------

describe("computeTimelineLayout", () => {
  it("returns empty layout for no requests", () => {
    const result = computeTimelineLayout({ requests: [], viewWidth: 800 });

    expect(result.bars).toHaveLength(0);
    expect(result.connectors).toHaveLength(0);
    expect(result.trackCount).toBe(0);
  });

  it("positions a single request at the center of the range", () => {
    const result = computeTimelineLayout({
      requests: [makeReq({ requestId: "r1", timestamp: 1000 })],
      viewWidth: 800,
      padding: 40,
    });

    expect(result.bars).toHaveLength(1);
    const bar = result.bars[0];
    // Single request: min === max, so linearScale returns midpoint of [padding, totalWidth-padding]
    expect(bar.track).toBe(0);
    expect(typeof bar.x).toBe("number");
    expect(typeof bar.y).toBe("number");
    expect(bar.width).toBeGreaterThanOrEqual(6);
    expect(bar.height).toBeGreaterThan(0);
  });

  it("orders multiple main requests left to right by timestamp", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "r1", timestamp: 1000 }),
        makeReq({ requestId: "r2", timestamp: 2000 }),
        makeReq({ requestId: "r3", timestamp: 3000 }),
      ],
      viewWidth: 800,
    });

    const byId = new Map(result.bars.map((b) => [b.requestId, b]));
    expect(byId.get("r1")!.x).toBeLessThan(byId.get("r2")!.x);
    expect(byId.get("r2")!.x).toBeLessThan(byId.get("r3")!.x);
  });

  it("assigns subagent requests to track 1", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "main1", timestamp: 1000 }),
        makeReq({
          requestId: "sub1",
          timestamp: 1500,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
        }),
      ],
      viewWidth: 800,
    });

    const byId = new Map(result.bars.map((b) => [b.requestId, b]));
    expect(byId.get("main1")!.track).toBe(0);
    expect(byId.get("sub1")!.track).toBe(1);
  });

  it("groups subagent requests by subagentId onto different tracks", () => {
    // Group A: ts 1100–1500, Group B: ts 1200–1600 — overlapping, forcing different tracks
    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "main1", timestamp: 1000 }),
        makeReq({
          requestId: "subA1",
          timestamp: 1100,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
        }),
        makeReq({
          requestId: "subA2",
          timestamp: 1500,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
        }),
        makeReq({
          requestId: "subB1",
          timestamp: 1200,
          isSubagent: true,
          subagentId: "agent-B",
          parentRequestId: "main1",
        }),
        makeReq({
          requestId: "subB2",
          timestamp: 1600,
          isSubagent: true,
          subagentId: "agent-B",
          parentRequestId: "main1",
        }),
      ],
      viewWidth: 800,
    });

    const byId = new Map(result.bars.map((b) => [b.requestId, b]));
    const trackA = byId.get("subA1")!.track;
    const trackB = byId.get("subB1")!.track;

    // Both subagents should be on subagent tracks (>= 1)
    expect(trackA).toBeGreaterThanOrEqual(1);
    expect(trackB).toBeGreaterThanOrEqual(1);
    // Because they overlap they must be on different tracks
    expect(trackA).not.toBe(trackB);

    // Within the same group, track should match
    expect(byId.get("subA2")!.track).toBe(trackA);
    expect(byId.get("subB2")!.track).toBe(trackB);
  });

  it("reuses tracks for non-overlapping subagent groups", () => {
    // Group A spans ts 1100–1200, group B starts at 2000 — no overlap
    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "main1", timestamp: 1000 }),
        makeReq({
          requestId: "subA1",
          timestamp: 1100,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
        }),
        makeReq({
          requestId: "subA2",
          timestamp: 1200,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
        }),
        makeReq({
          requestId: "subB1",
          timestamp: 2000,
          isSubagent: true,
          subagentId: "agent-B",
          parentRequestId: "main1",
        }),
      ],
      viewWidth: 800,
    });

    const byId = new Map(result.bars.map((b) => [b.requestId, b]));
    const trackA = byId.get("subA1")!.track;
    const trackB = byId.get("subB1")!.track;

    // Non-overlapping groups should share a track
    expect(trackA).toBe(trackB);
  });

  it("uses separate tracks for overlapping subagent groups", () => {
    // Group A: 1100–1500, Group B: 1300–1800 — overlapping
    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "main1", timestamp: 1000 }),
        makeReq({
          requestId: "subA1",
          timestamp: 1100,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
        }),
        makeReq({
          requestId: "subA2",
          timestamp: 1500,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
        }),
        makeReq({
          requestId: "subB1",
          timestamp: 1300,
          isSubagent: true,
          subagentId: "agent-B",
          parentRequestId: "main1",
        }),
        makeReq({
          requestId: "subB2",
          timestamp: 1800,
          isSubagent: true,
          subagentId: "agent-B",
          parentRequestId: "main1",
        }),
      ],
      viewWidth: 800,
    });

    const byId = new Map(result.bars.map((b) => [b.requestId, b]));
    const trackA = byId.get("subA1")!.track;
    const trackB = byId.get("subB1")!.track;

    expect(trackA).not.toBe(trackB);
  });

  it("uses main color for main requests and subagent colors by agent type", () => {
    const MAIN_COLOR = "#fbbf24";
    // Explore with no customAgentNames → built-in → amber cycle
    const EXPLORE_COLOR = "#fbbf24";

    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "main1", timestamp: 1000 }),
        makeReq({
          requestId: "sub1",
          timestamp: 2000,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
          customAgentName: "Explore",
        }),
        makeReq({
          requestId: "sub2",
          timestamp: 3000,
          isSubagent: true,
          subagentId: "agent-B",
          parentRequestId: "main1",
          customAgentName: "Explore",
        }),
      ],
      viewWidth: 800,
    });

    const byId = new Map(result.bars.map((b) => [b.requestId, b]));
    expect(byId.get("main1")!.color).toBe(MAIN_COLOR);

    const subColor1 = byId.get("sub1")!.color;
    const subColor2 = byId.get("sub2")!.color;
    expect(subColor1).toBe(EXPLORE_COLOR);
    // Same agent type → same color
    expect(subColor1).toBe(subColor2);

    const connector = result.connectors.find(
      (c) => c.toRequestId === "sub1",
    );
    expect(connector!.color).toBe(subColor1);
  });

  it("assigns different colors to different agent types", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "main1", timestamp: 1000 }),
        makeReq({
          requestId: "sub1",
          timestamp: 2000,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
          customAgentName: "Explore",
        }),
        makeReq({
          requestId: "sub2",
          timestamp: 3000,
          isSubagent: true,
          subagentId: "agent-B",
          parentRequestId: "main1",
          customAgentName: "compact",
        }),
      ],
      viewWidth: 800,
    });

    const byId = new Map(result.bars.map((b) => [b.requestId, b]));
    // Different agent types → different colors
    expect(byId.get("sub1")!.color).not.toBe(byId.get("sub2")!.color);
  });

  it("produces legend entries for each agent type", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "main1", timestamp: 1000 }),
        makeReq({
          requestId: "sub1",
          timestamp: 2000,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
          customAgentName: "Explore",
        }),
        makeReq({
          requestId: "sub2",
          timestamp: 3000,
          isSubagent: true,
          subagentId: "agent-B",
          parentRequestId: "main1",
          customAgentName: "compact",
        }),
      ],
      viewWidth: 800,
    });

    expect(result.legend).toHaveLength(3); // claude-code + Explore + compact
    const labels = result.legend.map((l) => l.label);
    expect(labels).toContain("claude-code");
    expect(labels).toContain("Explore");
    expect(labels).toContain("compact");
  });

  it("respects minimum bar spacing for content width", () => {
    const requests = Array.from({ length: 100 }, (_, i) =>
      makeReq({ requestId: `r${i}`, timestamp: i * 1000 }),
    );

    const result = computeTimelineLayout({
      requests,
      viewWidth: 500,
      minBarSpacing: 20,
    });

    // 100 requests * 20px spacing = 2000, which exceeds viewWidth 500
    expect(result.totalWidth).toBeGreaterThanOrEqual(2000);
  });

  it("handles requests with the same timestamp without crashing", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "r1", timestamp: 5000 }),
        makeReq({ requestId: "r2", timestamp: 5000 }),
        makeReq({ requestId: "r3", timestamp: 5000 }),
      ],
      viewWidth: 800,
    });

    expect(result.bars).toHaveLength(3);
    // All at the same timestamp — all get the same x (midpoint)
    const xs = result.bars.map((b) => b.x);
    for (const x of xs) {
      expect(typeof x).toBe("number");
      expect(Number.isFinite(x)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — bar width calculation
// ---------------------------------------------------------------------------

describe("bar width calculation", () => {
  it("uses totalElapsed for bar width when available", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({
          requestId: "r1",
          timestamp: 1000,
          timings: { totalElapsed: 5000 },
        }),
        makeReq({
          requestId: "r2",
          timestamp: 10000,
          timings: { totalElapsed: 2000 },
        }),
      ],
      viewWidth: 800,
    });

    const byId = new Map(result.bars.map((b) => [b.requestId, b]));
    // r1 has longer duration, so wider bar
    expect(byId.get("r1")!.width).toBeGreaterThan(byId.get("r2")!.width);
  });

  it("falls back to token-proportional width when totalElapsed is null", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({
          requestId: "r1",
          timestamp: 1000,
          usage: { promptTokens: 500, completionTokens: 500 },
        }),
        makeReq({
          requestId: "r2",
          timestamp: 5000,
          usage: { promptTokens: 50, completionTokens: 50 },
        }),
      ],
      viewWidth: 800,
    });

    const byId = new Map(result.bars.map((b) => [b.requestId, b]));
    // r1 has more tokens, so wider bar
    expect(byId.get("r1")!.width).toBeGreaterThan(byId.get("r2")!.width);
  });

  it("enforces minimum bar width", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({
          requestId: "r1",
          timestamp: 1000,
          timings: { totalElapsed: 1 },
        }),
      ],
      viewWidth: 800,
      minBarWidth: 10,
    });

    expect(result.bars[0].width).toBeGreaterThanOrEqual(10);
  });

  it("last request on track gets minimum width", () => {
    const result = computeTimelineLayout({
      requests: [makeReq({ requestId: "r1", timestamp: 1000 })],
      viewWidth: 800,
    });

    // Single request = last on its track, gets minimum width
    expect(result.bars[0].width).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Tests — connector geometry
// ---------------------------------------------------------------------------

describe("connector geometry", () => {
  it("produces no connectors when there are no subagents", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "r1", timestamp: 1000 }),
        makeReq({ requestId: "r2", timestamp: 2000 }),
      ],
      viewWidth: 800,
    });

    expect(result.connectors).toHaveLength(0);
  });

  it("produces one connector per subagent group", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "main1", timestamp: 1000 }),
        makeReq({
          requestId: "subA1",
          timestamp: 1500,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
        }),
        makeReq({
          requestId: "subA2",
          timestamp: 2000,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
        }),
        makeReq({
          requestId: "subB1",
          timestamp: 3000,
          isSubagent: true,
          subagentId: "agent-B",
          parentRequestId: "main1",
        }),
      ],
      viewWidth: 800,
    });

    expect(result.connectors).toHaveLength(2);
  });

  it("connector is a vertical drop at child's start x-position", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({
          requestId: "main1",
          timestamp: 1000,
          timings: { totalElapsed: 500 },
        }),
        makeReq({
          requestId: "sub1",
          timestamp: 2000,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
        }),
      ],
      viewWidth: 800,
    });

    const c = result.connectors[0];
    const parentBar = result.bars.find((b) => b.requestId === "main1")!;
    const childBar = result.bars.find((b) => b.requestId === "sub1")!;
    // Vertical drop at child's x position
    expect(c.x).toBeCloseTo(childBar.x);
    expect(c.fromY).toBe(parentBar.y);
    expect(c.toY).toBe(childBar.y);
  });

  it("skips connector when parent request is missing", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({
          requestId: "sub1",
          timestamp: 2000,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "nonexistent",
        }),
      ],
      viewWidth: 800,
    });

    expect(result.connectors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — case-insensitive custom agent matching
// ---------------------------------------------------------------------------

describe("case-insensitive custom agent matching", () => {
  it("assigns teal color to custom agents with case-insensitive matching", () => {
    const TEAL_COLORS = ["#5eead4", "#2dd4bf", "#14b8a6", "#0d9488", "#0f766e"];

    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "main1", timestamp: 1000 }),
        makeReq({
          requestId: "sub1",
          timestamp: 2000,
          isSubagent: true,
          subagentId: "agent-A",
          parentRequestId: "main1",
          customAgentName: "planner",
        }),
      ],
      viewWidth: 800,
      customAgentNames: ["Planner"],
    });

    const byId = new Map(result.bars.map((b) => [b.requestId, b]));
    const subBar = byId.get("sub1")!;
    expect(TEAL_COLORS).toContain(subBar.color);
  });

  it("assigns teal color to custom agents on the main track (not subagents)", () => {
    const TEAL_COLORS = ["#5eead4", "#2dd4bf", "#14b8a6", "#0d9488", "#0f766e"];

    const result = computeTimelineLayout({
      requests: [
        makeReq({
          requestId: "r1",
          timestamp: 1000,
          customAgentName: "planner",
        }),
        makeReq({
          requestId: "r2",
          timestamp: 2000,
          customAgentName: "planner",
        }),
      ],
      viewWidth: 800,
      customAgentNames: ["Planner"],
    });

    const byId = new Map(result.bars.map((b) => [b.requestId, b]));
    // Main-track requests with a custom agent name should get teal, not amber
    expect(TEAL_COLORS).toContain(byId.get("r1")!.color);
    expect(TEAL_COLORS).toContain(byId.get("r2")!.color);
    // Both should have the same color (same agent type)
    expect(byId.get("r1")!.color).toBe(byId.get("r2")!.color);
  });
});

// ---------------------------------------------------------------------------
// Tests — MCP mini-bars
// ---------------------------------------------------------------------------

describe("MCP mini-bars", () => {
  it("generates MCP mini-bars below parent bar", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({
          requestId: "r1",
          timestamp: 1000,
          mcpToolCalls: [{ name: "read_file", server: "FastMCP" }],
        }),
      ],
      viewWidth: 800,
    });

    const mcpBars = result.bars.filter((b) => b.isMcp);
    expect(mcpBars).toHaveLength(1);
    const mcpBar = mcpBars[0];
    expect(mcpBar.isMcp).toBe(true);
    expect(mcpBar.mcpServer).toBe("FastMCP");
    expect(mcpBar.mcpToolName).toBe("read_file");
    expect(mcpBar.requestId).toBe("r1");
    expect(mcpBar.height).toBe(4);

    // Mini-bar should be positioned below its parent
    const parentBar = result.bars.find((b) => b.requestId === "r1" && !b.isMcp)!;
    expect(mcpBar.y).toBeGreaterThan(parentBar.y);
    expect(mcpBar.x).toBe(parentBar.x);
    expect(mcpBar.width).toBe(parentBar.width);
  });

  it("stacks multiple MCP mini-bars with 2px gap", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({
          requestId: "r1",
          timestamp: 1000,
          mcpToolCalls: [
            { name: "read_file", server: "FastMCP" },
            { name: "write_file", server: "FastMCP" },
          ],
        }),
      ],
      viewWidth: 800,
    });

    const mcpBars = result.bars.filter((b) => b.isMcp);
    expect(mcpBars).toHaveLength(2);
    // Second mini-bar should be below the first
    expect(mcpBars[1].y).toBeGreaterThan(mcpBars[0].y);
    // Gap between them should be exactly 4 (height) + 2 (gap)
    expect(mcpBars[1].y - mcpBars[0].y).toBe(4 + 2);
  });

  it("produces no isMcp bars when no mcpToolCalls", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({ requestId: "r1", timestamp: 1000 }),
        makeReq({ requestId: "r2", timestamp: 2000 }),
      ],
      viewWidth: 800,
    });

    const mcpBars = result.bars.filter((b) => b.isMcp);
    expect(mcpBars).toHaveLength(0);
  });

  it("does not increase trackCount for MCP mini-bars", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({
          requestId: "r1",
          timestamp: 1000,
          mcpToolCalls: [
            { name: "read_file", server: "FastMCP" },
            { name: "list_dir", server: "FastMCP" },
            { name: "search", server: "GitKraken" },
          ],
        }),
      ],
      viewWidth: 800,
    });

    // Only one main track — MCP bars must not add tracks
    expect(result.trackCount).toBe(1);
  });

  it("adds MCP servers to the legend", () => {
    const result = computeTimelineLayout({
      requests: [
        makeReq({
          requestId: "r1",
          timestamp: 1000,
          mcpToolCalls: [
            { name: "read_file", server: "FastMCP" },
            { name: "commit", server: "GitKraken" },
          ],
        }),
      ],
      viewWidth: 800,
    });

    const legendLabels = result.legend.map((e) => e.label);
    expect(legendLabels).toContain("MCP: FastMCP");
    expect(legendLabels).toContain("MCP: GitKraken");

    const fastmcpEntry = result.legend.find((e) => e.label === "MCP: FastMCP");
    expect(fastmcpEntry?.color).toBe("#60a5fa");
  });
});

// ---------------------------------------------------------------------------
// Tests — computeMinimapViewport
// ---------------------------------------------------------------------------

describe("computeMinimapViewport", () => {
  it("computes scale as container / total", () => {
    const vp = computeMinimapViewport(2000, 800, 0);
    expect(vp.scale).toBeCloseTo(0.4);
  });

  it("positions indicator based on scrollX", () => {
    const vp = computeMinimapViewport(2000, 800, 500);
    expect(vp.indicatorX).toBeCloseTo(200);
    expect(vp.indicatorWidth).toBeCloseTo(320);
  });

  it("indicator fills full width when totalWidth equals containerWidth", () => {
    const vp = computeMinimapViewport(800, 800, 0);
    expect(vp.scale).toBeCloseTo(1);
    expect(vp.indicatorWidth).toBeCloseTo(800);
  });
});
