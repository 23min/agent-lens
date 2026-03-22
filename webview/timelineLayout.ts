// ---------------------------------------------------------------------------
// Timeline layout — pure function, no DOM or D3 dependency.
//
// Computes bar positions, track assignments, connector geometry, and minimap
// viewport for an SVG timeline visualization of session requests.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimelineBar {
  requestId: string;
  x: number;         // left edge of bar (pixels)
  y: number;         // vertical center position (pixels)
  width: number;     // bar width (pixels)
  height: number;    // bar height (pixels)
  track: number;     // 0 = main track, 1+ = subagent branches
  color: string;     // bar fill color
  label: string;     // agent name for tooltip
  isSubagent: boolean;
  isMcp?: boolean;
  mcpServer?: string;
  mcpToolName?: string;
}

export interface TimelineConnector {
  fromRequestId: string;
  toRequestId: string;
  x: number;         // x-position of vertical drop (= child bar left edge)
  fromY: number;     // y on parent track
  toY: number;       // y on child track
  color: string;
}

export interface LegendEntry {
  label: string;
  color: string;
}

export interface TimelineLayoutResult {
  bars: TimelineBar[];
  connectors: TimelineConnector[];
  legend: LegendEntry[];
  totalWidth: number;
  trackCount: number;              // total number of tracks (1 = main only)
  timeRange: [number, number];     // [minTimestamp, maxTimestamp]
}

export interface TimelineLayoutInput {
  requests: SessionRequestLike[];
  viewWidth: number;
  minBarSpacing?: number;      // default 20
  minBarWidth?: number;        // default 6
  maxBarWidth?: number;        // default 40
  barHeight?: number;          // default 8
  trackHeight?: number;        // default 22
  padding?: number;            // default 16
  customAgentNames?: string[]; // agent names from .claude/agents/ & .github/agents/
}

/** Minimal interface so we don't import from session.ts */
export interface SessionRequestLike {
  requestId: string;
  timestamp: number;
  agentId: string;
  customAgentName: string | null;
  modelId?: string;
  isSubagent?: boolean;
  subagentId?: string;
  parentRequestId?: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  timings?: {
    totalElapsed: number | null;
  };
  mcpToolCalls?: { name: string; server: string }[];
}

export interface MinimapViewport {
  scale: number;
  indicatorX: number;
  indicatorWidth: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Color palette:
//   Custom agents (.claude/agents/, .github/agents/) → teal shades
//   Built-in agents → amber shades
//   compact → coral
//   Main track → amber
const COMPACT_COLOR = "#fb7185";  // rose-400 (coral)
const MAIN_COLOR = "#fbbf24";     // amber-400

// Teal cycle for custom agents (discovered from .claude/agents/ etc.)
const CUSTOM_COLORS = [
  "#5eead4",  // teal-300
  "#2dd4bf",  // teal-400
  "#14b8a6",  // teal-500
  "#0d9488",  // teal-600
  "#0f766e",  // teal-700
];
// Amber cycle for built-in agents (not in custom agent dirs)
const BUILTIN_COLORS = [
  "#fbbf24",  // amber-400
  "#f59e0b",  // amber-500
  "#d97706",  // amber-600
  "#b45309",  // amber-700
];
const MCP_COLOR = "#60a5fa";  // blue-400
const DEFAULT_MIN_BAR_WIDTH = 6;
const DEFAULT_MAX_BAR_WIDTH = 40;
const DEFAULT_BAR_HEIGHT = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Linear interpolation from domain [d0, d1] to range [r0, r1]. */
function linearScale(
  value: number,
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): number {
  if (d0 === d1) return (r0 + r1) / 2;
  return r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

// ---------------------------------------------------------------------------
// Minimap viewport — pure function
// ---------------------------------------------------------------------------

export function computeMinimapViewport(
  totalWidth: number,
  containerWidth: number,
  scrollX: number,
): MinimapViewport {
  const scale = containerWidth / totalWidth;
  return {
    scale,
    indicatorX: scrollX * scale,
    indicatorWidth: containerWidth * scale,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function computeTimelineLayout(
  input: TimelineLayoutInput,
): TimelineLayoutResult {
  const {
    requests,
    viewWidth,
    minBarSpacing = 20,
    minBarWidth = DEFAULT_MIN_BAR_WIDTH,
    maxBarWidth = DEFAULT_MAX_BAR_WIDTH,
    barHeight = DEFAULT_BAR_HEIGHT,
    trackHeight = 22,
    padding = 16,
  } = input;

  const empty: TimelineLayoutResult = {
    bars: [],
    connectors: [],
    legend: [],
    totalWidth: viewWidth,
    trackCount: 0,
    timeRange: [0, 0],
  };

  if (requests.length === 0) return empty;

  // 1. Time range
  let minTs = requests[0].timestamp;
  let maxTs = requests[0].timestamp;
  for (const r of requests) {
    if (r.timestamp < minTs) minTs = r.timestamp;
    if (r.timestamp > maxTs) maxTs = r.timestamp;
  }

  // 2. Content width — at least viewWidth, but grows with request count
  const totalWidth = Math.max(viewWidth, requests.length * minBarSpacing);
  const rangeLeft = padding;
  const rangeRight = totalWidth - padding;

  // Helper: timestamp → x
  const tsToX = (ts: number): number =>
    linearScale(ts, minTs, maxTs, rangeLeft, rangeRight);

  // 3. Index requests by requestId for parent lookups
  const requestById = new Map<string, SessionRequestLike>();
  for (const r of requests) {
    requestById.set(r.requestId, r);
  }

  // 4. Group subagent requests by subagentId
  const subagentGroups = new Map<string, SessionRequestLike[]>();
  for (const r of requests) {
    if (r.isSubagent && r.subagentId) {
      let group = subagentGroups.get(r.subagentId);
      if (!group) {
        group = [];
        subagentGroups.set(r.subagentId, group);
      }
      group.push(r);
    }
  }

  // 5. Assign colors by agent type (label), not per-instance
  //    Custom agents (from .claude/agents/ etc.) → teal cycle
  //    Built-in agents → amber cycle
  //    compact → coral
  const customNameSet = new Set((input.customAgentNames ?? []).map((n) => n.toLowerCase()));
  const agentTypeToColor = new Map<string, string>();
  let customColorIdx = 0;
  let builtinColorIdx = 0;
  // Scan all requests (not just subagents) so main-track custom agents get a color too
  for (const r of requests) {
    const label = r.customAgentName ?? r.agentId;
    if (!agentTypeToColor.has(label)) {
      if (label === "compact") {
        agentTypeToColor.set(label, COMPACT_COLOR);
      } else if (customNameSet.has(label.toLowerCase())) {
        agentTypeToColor.set(label, CUSTOM_COLORS[customColorIdx % CUSTOM_COLORS.length]);
        customColorIdx++;
      } else if (r.isSubagent === true && r.subagentId !== undefined) {
        agentTypeToColor.set(label, BUILTIN_COLORS[builtinColorIdx % BUILTIN_COLORS.length]);
        builtinColorIdx++;
      }
    }
  }

  // 6. Assign tracks using greedy interval scheduling (track 0 = main)
  //    Track 0 = main. Subagent groups get track 1+.
  const trackEnds: number[] = []; // index 0 unused (main track)

  const subagentIdToTrack = new Map<string, number>();

  for (const [subagentId, group] of subagentGroups) {
    const groupMin = Math.min(...group.map((r) => r.timestamp));
    const groupMax = Math.max(...group.map((r) => r.timestamp));

    // Find the first track (1+) where groupMin > trackEnds[track]
    let assignedTrack = -1;
    for (let t = 1; t <= trackEnds.length; t++) {
      const trackEnd = trackEnds[t] ?? -Infinity;
      if (groupMin > trackEnd) {
        assignedTrack = t;
        break;
      }
    }

    if (assignedTrack === -1) {
      assignedTrack = 1; // first subagent group; loop didn't run (trackEnds empty)
    }

    trackEnds[assignedTrack] = groupMax;
    subagentIdToTrack.set(subagentId, assignedTrack);
  }

  // trackCount = 1 (main) + number of distinct subagent tracks used
  const maxSubagentTrack =
    subagentIdToTrack.size > 0 ? Math.max(...subagentIdToTrack.values()) : 0;
  const trackCount = maxSubagentTrack + 1;

  // Helper: get color for a request by its agent type
  const colorForRequest = (r: SessionRequestLike): string => {
    const label = r.customAgentName ?? r.agentId;
    // compact → coral regardless of track
    if (label === "compact") return COMPACT_COLOR;
    // Use assigned color from step 5 (covers both subagents and main-track custom agents)
    return agentTypeToColor.get(label) ?? MAIN_COLOR;
  };

  // 7. Sort requests per track (by timestamp) for gap-based width calculation
  const requestsByTrack = new Map<number, SessionRequestLike[]>();
  for (const r of requests) {
    const isSubagent = r.isSubagent === true && r.subagentId !== undefined;
    const track = isSubagent
      ? (subagentIdToTrack.get(r.subagentId!) ?? 0)
      : 0;
    let list = requestsByTrack.get(track);
    if (!list) {
      list = [];
      requestsByTrack.set(track, list);
    }
    list.push(r);
  }
  for (const list of requestsByTrack.values()) {
    list.sort((a, b) => a.timestamp - b.timestamp);
  }

  // 8. Compute max token count for proportional bar widths
  let maxTokens = 0;
  for (const r of requests) {
    const tokens = r.usage.promptTokens + r.usage.completionTokens;
    if (tokens > maxTokens) maxTokens = tokens;
  }

  // 9. Build bars
  const bars: TimelineBar[] = requests.map((r) => {
    const isSubagent = r.isSubagent === true && r.subagentId !== undefined;
    const track = isSubagent
      ? (subagentIdToTrack.get(r.subagentId!) ?? 0)
      : 0;
    const color = colorForRequest(r);
    const x = tsToX(r.timestamp);
    const y = padding + track * trackHeight;
    const label = r.customAgentName ?? r.agentId;

    // Find next request on same track to clamp width
    const trackList = requestsByTrack.get(track) ?? [];
    const idx = trackList.indexOf(r);
    const nextOnTrack =
      idx >= 0 && idx < trackList.length - 1 ? trackList[idx + 1] : null;

    // Compute bar width
    let width: number;

    // Priority 1: use totalElapsed if available
    if (r.timings?.totalElapsed != null && r.timings.totalElapsed > 0) {
      const endX = tsToX(r.timestamp + r.timings.totalElapsed);
      width = Math.max(endX - x, minBarWidth);
    } else {
      // Priority 2: token-proportional width
      const tokens = r.usage.promptTokens + r.usage.completionTokens;
      const ratio = maxTokens > 0 ? tokens / maxTokens : 0;
      width = minBarWidth + ratio * (maxBarWidth - minBarWidth);
    }

    // Clamp: bar must not extend past next bar's x on same track
    if (nextOnTrack) {
      const nextX = tsToX(nextOnTrack.timestamp);
      width = Math.min(width, nextX - x);
      width = Math.max(width, minBarWidth);
    }

    return {
      requestId: r.requestId,
      x,
      y,
      width,
      height: barHeight,
      track,
      color,
      label,
      isSubagent,
    };
  });

  // Build a map from requestId → bar for connector lookups
  const barById = new Map<string, TimelineBar>();
  for (const b of bars) {
    barById.set(b.requestId, b);
  }

  // 9b. Generate MCP mini-bars (stacked below each parent bar, 4px tall, 2px gap)
  //     These do NOT consume a new track — they are purely visual decorations.
  for (const r of requests) {
    if (!r.mcpToolCalls || r.mcpToolCalls.length === 0) continue;
    const parentBar = barById.get(r.requestId);
    if (!parentBar) continue;

    r.mcpToolCalls.forEach((tc, idx) => {
      const miniY = parentBar.y + parentBar.height / 2 + 2 + idx * (4 + 2);
      bars.push({
        requestId: r.requestId,
        x: parentBar.x,
        y: miniY,
        width: parentBar.width,
        height: 4,
        track: parentBar.track,
        color: MCP_COLOR,
        label: `MCP: ${tc.server}`,
        isSubagent: parentBar.isSubagent,
        isMcp: true,
        mcpServer: tc.server,
        mcpToolName: tc.name,
      });
    });
  }

  // 10. Build connectors (vertical drop from parent track to child bar start)
  const connectors: TimelineConnector[] = [];

  for (const [, group] of subagentGroups) {
    const sorted = [...group].sort((a, b) => a.timestamp - b.timestamp);
    const first = sorted[0];

    const childBar = barById.get(first.requestId);
    if (!childBar) continue;

    // Find parent bar
    let parentBar: TimelineBar | undefined;
    if (first.parentRequestId) {
      parentBar = barById.get(first.parentRequestId);
    }

    if (parentBar) {
      connectors.push({
        fromRequestId: parentBar.requestId,
        toRequestId: childBar.requestId,
        x: childBar.x,
        fromY: parentBar.y,
        toY: childBar.y,
        color: childBar.color,
      });
    }
  }

  // 11. Build legend from actual bars (deduplicated by label)
  //    Sort order: built-in/main (amber) first, compact (coral), custom (teal), MCP (blue) last
  const legendMap = new Map<string, string>();
  for (const b of bars) {
    // Skip MCP mini-bars — they are added separately below
    if (b.isMcp) continue;
    if (!legendMap.has(b.label)) {
      legendMap.set(b.label, b.color);
    }
  }
  // Add MCP servers to legend (deduplicated by server name)
  const mcpServersInLegend = new Set<string>();
  for (const r of requests) {
    if (!r.mcpToolCalls) continue;
    for (const tc of r.mcpToolCalls) {
      mcpServersInLegend.add(tc.server);
    }
  }
  for (const server of mcpServersInLegend) {
    legendMap.set(`MCP: ${server}`, MCP_COLOR);
  }
  const legend: LegendEntry[] = [];
  for (const [label, color] of legendMap) {
    legend.push({ label, color });
  }
  legend.sort((a, b) => {
    // group: 0 = built-in/main (amber), 1 = compact (coral), 2 = custom (teal), 3 = MCP (blue)
    const aIsCustom = customNameSet.has(a.label.toLowerCase());
    const bIsCustom = customNameSet.has(b.label.toLowerCase());
    const groupOf = (entry: LegendEntry, isCustom: boolean) => {
      if (entry.color === MCP_COLOR) return 3;
      if (isCustom || CUSTOM_COLORS.includes(entry.color)) return 2;
      if (entry.color === COMPACT_COLOR) return 1;
      return 0;
    };
    return groupOf(a, aIsCustom) - groupOf(b, bIsCustom);
  });

  return {
    bars,
    connectors,
    legend,
    totalWidth,
    trackCount,
    timeRange: [minTs, maxTs],
  };
}
