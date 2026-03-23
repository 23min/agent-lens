import { LitElement, html, css, svg } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { arc as d3Arc, pie as d3Pie } from "d3";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

type SourceFilter = "all" | "copilot" | "claude" | "codex";
type TimeScope = "all" | "today" | "last-hour";

interface SessionMeta {
  sessionId: string;
  title: string | null;
  creationDate: number;
  lastActivity: number;
  provider: string;
  projectName?: string;
  isCurrentWorkspace?: boolean;
}

interface CountEntry {
  name: string;
  count: number;
  isCustom?: boolean;
}


interface TokenEntry {
  name: string;
  promptTokens: number;
  completionTokens: number;
}

interface UnusedEntry {
  name: string;
  provider?: string;
}

interface AggregatedMetrics {
  totalSessions: number;
  totalRequests: number;
  totalTokens: { prompt: number; completion: number };
  cacheTokens: { read: number; creation: number };
  agentUsage: CountEntry[];
  modelUsage: CountEntry[];
  toolUsage: CountEntry[];
  skillUsage: CountEntry[];
  tokensByAgent: TokenEntry[];
  tokensByModel: TokenEntry[];
  activity: { date: string; count: number }[];
  unusedAgents: UnusedEntry[];
  unusedSkills: UnusedEntry[];
  mcpServerUsage: CountEntry[];
}

interface DonutSlice {
  name: string;
  value: number;
  color: string;
}

const DONUT_PALETTE = [
  "#c4a882",
  "#b09090",
  "#8aab7f",
  "#c9b87c",
  "#b8806a",
  "#8fa3a3",
  "#b5a898",
  "#7a9468",
];

@customElement("metrics-dashboard")
class MetricsDashboard extends LitElement {
  static styles = css`
    :host {
      display: block;
      max-width: 900px;
      margin: 0 auto;
    }
    h1 {
      font-size: 20px;
      margin: 0;
      font-weight: 500;
    }
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    h2 {
      font-size: 14px;
      margin: 24px 0 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.7;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 6px;
      padding: 16px;
      position: relative;
    }
    .stat-card[title] {
      cursor: help;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 600;
      line-height: 1;
    }
    .stat-label {
      font-size: 11px;
      opacity: 0.6;
      margin-top: 4px;
    }
    .stat-cost {
      display: inline-block;
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      margin-top: 6px;
      font-weight: 500;
    }
    .stat-cost.full {
      background: rgba(184, 128, 106, 0.2);
      color: #b8806a;
    }
    .stat-cost.cheap {
      background: rgba(138, 171, 127, 0.2);
      color: #8aab7f;
    }
    .stat-cost.premium {
      background: rgba(201, 184, 124, 0.2);
      color: #c9b87c;
    }
    .stat-cost.free {
      background: rgba(138, 171, 127, 0.15);
      color: #8aab7f;
    }
    .bar-chart {
      margin: 8px 0 16px;
    }
    .bar-row {
      display: flex;
      align-items: center;
      margin: 4px 0;
      font-size: 12px;
    }
    .bar-label {
      width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .bar-label--custom {
      color: #4ec9b0;
      font-weight: 600;
    }
    .bar-track {
      flex: 1;
      height: 18px;
      background: var(--vscode-editorWidget-border, #333);
      border-radius: 3px;
      overflow: hidden;
      margin: 0 8px;
    }
    .bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .bar-count {
      width: 40px;
      text-align: right;
      opacity: 0.7;
      flex-shrink: 0;
    }
    .unused-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 8px 0;
    }
    .unused-tag {
      background: var(--vscode-inputValidation-warningBackground, #352a05);
      border: 1px solid var(--vscode-inputValidation-warningBorder, #9d8b1e);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 12px;
    }
    .unused-provider {
      font-size: 10px;
      opacity: 0.6;
      margin-left: 2px;
    }
    .empty-state {
      opacity: 0.5;
      font-style: italic;
      font-size: 13px;
      padding: 8px 0;
    }
    .stat-note {
      font-size: 10px;
      opacity: 0.5;
      margin-top: 4px;
      font-style: italic;
    }
    .donut-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin: 8px 0 24px;
    }
    .donut-card {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 6px;
      padding: 16px;
    }
    .donut-title {
      font-size: 11px;
      opacity: 0.6;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .donut-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .donut-legend {
      width: 100%;
      font-size: 12px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 3px 0;
    }
    .legend-swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .legend-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .legend-value {
      opacity: 0.7;
      flex-shrink: 0;
    }
    .toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px 12px;
      margin-bottom: 16px;
    }
    .filter-toggle {
      display: inline-flex;
      flex-shrink: 0;
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 4px;
      overflow: hidden;
    }
    .filter-btn {
      background: none;
      border: none;
      border-right: 1px solid var(--vscode-editorWidget-border, #454545);
      color: var(--vscode-editor-foreground);
      padding: 4px 14px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      opacity: 0.7;
    }
    .filter-btn:last-child {
      border-right: none;
    }
    .filter-btn:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .filter-btn.active {
      opacity: 1;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    .session-select {
      background: var(--vscode-dropdown-background, #3c3c3c);
      border: 1px solid var(--vscode-dropdown-border, #454545);
      color: var(--vscode-dropdown-foreground, var(--vscode-editor-foreground));
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      opacity: 0.7;
      max-width: 180px;
    }
    .session-select option {
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, var(--vscode-editor-foreground));
    }
    .session-select:hover, .session-select:focus {
      opacity: 1;
      outline: none;
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .filter-toggle.inactive {
      opacity: 0.3;
      pointer-events: none;
    }
    .session-select.inactive {
      opacity: 0.3;
      pointer-events: none;
    }
    .tooltip {
      position: fixed;
      background: var(--vscode-editorHoverWidget-background, #252526);
      border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
      color: var(--vscode-editorHoverWidget-foreground, #ccc);
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      pointer-events: none;
      z-index: 100;
      max-width: 280px;
      line-height: 1.5;
    }
    .token-guide {
      position: relative;
    }
    .guide-toggle {
      background: none;
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      color: var(--vscode-editor-foreground);
      padding: 6px 14px;
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      opacity: 0.7;
    }
    .guide-toggle:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .guide-content {
      margin-top: 8px;
      margin-bottom: 16px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 6px;
      padding: 16px;
      font-size: 12px;
      line-height: 1.6;
    }
    .guide-content dt {
      font-weight: 600;
      margin-top: 10px;
    }
    .guide-content dt:first-child {
      margin-top: 0;
    }
    .guide-content dd {
      margin: 2px 0 0 0;
      opacity: 0.8;
    }
    .guide-cost {
      display: inline-block;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      margin-left: 6px;
      font-weight: 400;
    }
    .guide-cost.full {
      background: rgba(184, 128, 106, 0.2);
      color: #b8806a;
    }
    .guide-cost.cheap {
      background: rgba(138, 171, 127, 0.2);
      color: #8aab7f;
    }
    .guide-cost.premium {
      background: rgba(201, 184, 124, 0.2);
      color: #c9b87c;
    }
  `;

  @state() private metrics: AggregatedMetrics | null = null;
  @state() private emptyCount = 0;
  @state() private activeFilter: SourceFilter = "all";
  @state() private activeScope: TimeScope = "all";
  @state() private activeProject: string | null = null;
  @state() private activeSession: string | null = null;
  @state() private sessions: SessionMeta[] = [];
  @state() private guideOpen = false;
  @state() private tooltip: {
    x: number;
    y: number;
    name: string;
    detail: string;
  } | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.handleMessage);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("message", this.handleMessage);
  }

  private handleMessage = (e: MessageEvent): void => {
    if (e.data.type === "update-metrics") {
      this.metrics = e.data.metrics;
      this.emptyCount = e.data.emptyCount ?? 0;
      if (e.data.activeFilter) this.activeFilter = e.data.activeFilter;
      if (e.data.activeScope) this.activeScope = e.data.activeScope;
      if ("activeProject" in e.data) this.activeProject = e.data.activeProject;
      if ("activeSession" in e.data) this.activeSession = e.data.activeSession;
      if (e.data.sessions) this.sessions = e.data.sessions;
    }
  };

  private onFilterChange(filter: SourceFilter): void {
    this.activeFilter = filter;
    vscode.postMessage({ type: "filter-change", provider: filter });
  }

  private onScopeChange(scope: TimeScope): void {
    this.activeScope = scope;
    vscode.postMessage({ type: "scope-change", scope });
  }

  private onProjectChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value;
    const project = value === "" ? null : value;
    this.activeProject = project;
    this.activeSession = null;
    vscode.postMessage({ type: "project-change", project });
  }

  private onSessionChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value;
    const sessionId = value === "" ? null : value;
    this.activeSession = sessionId;
    vscode.postMessage({ type: "session-change", sessionId });
  }

  private renderBarChart(
    entries: CountEntry[],
    color: string,
    maxItems = 10,
    tooltipData?: Map<
      string,
      { totalTokens: number; avgPrompt: number; avgCompletion: number }
    >,
  ) {
    const items = entries.slice(0, maxItems);
    const maxCount = Math.max(...items.map((e) => e.count), 1);

    return html`
      <div class="bar-chart">
        ${items.map(
          (entry) => html`
            <div
              class="bar-row"
              @mouseenter="${(e: MouseEvent) => {
                if (!tooltipData) return;
                const data = tooltipData.get(entry.name);
                if (!data) return;
                const customTag = entry.isCustom ? ' (custom agent)' : '';
                this.tooltip = {
                  x: e.clientX + 12,
                  y: e.clientY - 10,
                  name: entry.name + customTag,
                  detail: `${entry.count} requests · ${this.formatNumber(data.totalTokens)} tokens\nAvg prompt: ${this.formatNumber(data.avgPrompt)} · Avg completion: ${this.formatNumber(data.avgCompletion)}`,
                };
              }}"
              @mouseleave="${() => {
                this.tooltip = null;
              }}"
              @mousemove="${(e: MouseEvent) => {
                if (this.tooltip) {
                  this.tooltip = {
                    ...this.tooltip,
                    x: e.clientX + 12,
                    y: e.clientY - 10,
                  };
                }
              }}"
            >
              <span class=${classMap({ 'bar-label': true, 'bar-label--custom': !!entry.isCustom })} title="${tooltipData ? '' : entry.name}">${entry.name}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  style="width: ${(entry.count / maxCount) * 100}%; background: ${color};"
                ></div>
              </div>
              <span class="bar-count">${entry.count}</span>
            </div>
          `,
        )}
        ${items.length === 0
          ? html`<div class="empty-state">No data</div>`
          : null}
      </div>
    `;
  }

  private renderDonutChart(slices: DonutSlice[], size = 140) {
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    if (total === 0) {
      return html`<div class="empty-state">No data</div>`;
    }

    const outerR = size / 2 - 4;
    const innerR = outerR * 0.6;

    const arcGen = d3Arc<d3.PieArcDatum<DonutSlice>>()
      .innerRadius(innerR)
      .outerRadius(outerR);

    const pieGen = d3Pie<DonutSlice>()
      .value((d) => d.value)
      .sort(null);

    const arcs = pieGen(slices);

    return html`
      <div class="donut-container">
        <svg
          viewBox="0 0 ${size} ${size}"
          width="${size}"
          height="${size}"
        >
          <g transform="translate(${size / 2}, ${size / 2})">
            ${arcs.map(
              (a) => svg`
                <path d="${arcGen(a)}" fill="${a.data.color}" opacity="0.85" />
              `,
            )}
            <text
              text-anchor="middle"
              dy="5"
              fill="currentColor"
              font-size="14"
              font-weight="600"
            >
              ${this.formatNumber(total)}
            </text>
          </g>
        </svg>
        <div class="donut-legend">
          ${slices.map(
            (s) => html`
              <div class="legend-item">
                <span
                  class="legend-swatch"
                  style="background: ${s.color}"
                ></span>
                <span class="legend-label" title="${s.name}">${s.name}</span>
                <span class="legend-value">
                  ${this.formatNumber(s.value)}
                  (${Math.round((s.value / total) * 100)}%)
                </span>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderTokenGuide() {
    return html`
      <div class="guide-content">
        <dl>
          <dt>Total Tokens</dt>
          <dd>Sum of all token types processed across all requests. For Claude this includes cached tokens; for Copilot it is input + output.</dd>

          ${this.activeFilter !== "claude"
            ? html`
                <dt>
                  Copilot Tokens
                  <span class="guide-cost cheap">included in subscription</span>
                </dt>
                <dd>GitHub Copilot tokens (input and output) are covered by your Copilot subscription. There is no per-token billing — usage is metered against your plan's rate limits, not cost.</dd>
              `
            : null}

          ${this.activeFilter !== "copilot"
            ? html`
                <dt>
                  Output Tokens
                  <span class="guide-cost full">full price</span>
                </dt>
                <dd>Tokens generated by the model (its response). Billed at the full output rate.</dd>

                <dt>
                  Input Tokens (non-cached)
                  <span class="guide-cost full">full price</span>
                </dt>
                <dd>New input tokens sent to the model that weren't in the prompt cache. Billed at the full input rate.</dd>

                <dt>
                  Cache Read Tokens
                  <span class="guide-cost cheap">0.1x input price</span>
                </dt>
                <dd>Input tokens served from the prompt cache instead of being re-processed. 90% cheaper than regular input. Claude Code caches system prompts, tool definitions, and conversation history aggressively — this is typically the largest category.</dd>

                <dt>
                  Cache Creation Tokens
                  <span class="guide-cost premium">1.25x input price</span>
                </dt>
                <dd>Input tokens written to the prompt cache for the first time. Slightly more expensive (25% premium), but subsequent reads of these tokens are 90% cheaper.</dd>

                <dt>Cache Hit Ratio</dt>
                <dd>Percentage of total input tokens served from cache. Higher is better — a 97% ratio means only 3% of input tokens are billed at full price.</dd>
              `
            : null}
        </dl>
      </div>
    `;
  }

  private renderUnusedSection(label: string, entries: UnusedEntry[]) {
    if (entries.length === 0) return null;

    if (this.activeFilter !== "all") {
      // Single provider selected — flat list, no sub-headers needed
      return html`
        <div style="font-size: 12px; opacity: 0.6; margin-bottom: 4px; margin-top: 8px;">
          ${label} defined but never used:
        </div>
        <div class="unused-list">
          ${entries.map(
            (entry) => html`<span class="unused-tag">${entry.name}</span>`,
          )}
        </div>
      `;
    }

    // "All" filter — group by provider
    const copilot = entries.filter((e) => (e.provider ?? "copilot") === "copilot");
    const claude = entries.filter((e) => e.provider === "claude");

    return html`
      ${copilot.length > 0
        ? html`
            <div style="font-size: 12px; opacity: 0.6; margin-bottom: 4px; margin-top: 8px;">
              ${label} (Copilot) defined but never used:
            </div>
            <div class="unused-list">
              ${copilot.map(
                (entry) => html`<span class="unused-tag">${entry.name}</span>`,
              )}
            </div>
          `
        : null}
      ${claude.length > 0
        ? html`
            <div style="font-size: 12px; opacity: 0.6; margin-bottom: 4px; margin-top: 8px;">
              ${label} (Claude) defined but never used:
            </div>
            <div class="unused-list">
              ${claude.map(
                (entry) => html`<span class="unused-tag">${entry.name}</span>`,
              )}
            </div>
          `
        : null}
    `;
  }

  private formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  protected render() {
    if (!this.metrics) {
      return html`<div class="empty-state">Loading metrics...</div>`;
    }

    const m = this.metrics;

    // Build tooltip data for agent bar chart
    const agentTooltipData = new Map<
      string,
      { totalTokens: number; avgPrompt: number; avgCompletion: number }
    >();
    for (const t of m.tokensByAgent) {
      const requestCount =
        m.agentUsage.find((a) => a.name === t.name)?.count ?? 1;
      agentTooltipData.set(t.name, {
        totalTokens: t.promptTokens + t.completionTokens,
        avgPrompt: Math.round(t.promptTokens / requestCount),
        avgCompletion: Math.round(t.completionTokens / requestCount),
      });
    }

    // Build donut slices
    const agentSlices: DonutSlice[] = m.tokensByAgent.map((t, i) => ({
      name: t.name,
      value: t.promptTokens + t.completionTokens,
      color: DONUT_PALETTE[i % DONUT_PALETTE.length],
    }));

    const modelSlices: DonutSlice[] = m.tokensByModel.map((t, i) => ({
      name: t.name,
      value: t.promptTokens + t.completionTokens,
      color: DONUT_PALETTE[i % DONUT_PALETTE.length],
    }));

    const promptCompSlices: DonutSlice[] = [
      { name: "Prompt", value: m.totalTokens.prompt, color: "#c4a882" },
      {
        name: "Completion",
        value: m.totalTokens.completion,
        color: "#b09090",
      },
    ];

    const hasCacheTokens =
      m.cacheTokens.read > 0 || m.cacheTokens.creation > 0;
    const cacheInputSlices: DonutSlice[] = hasCacheTokens
      ? [
          { name: "Cache Read", value: m.cacheTokens.read, color: "#8aab7f" },
          {
            name: "Cache Creation",
            value: m.cacheTokens.creation,
            color: "#c9b87c",
          },
          {
            name: "Non-cached",
            value: m.totalTokens.prompt,
            color: "#b8806a",
          },
        ]
      : [];
    const cacheHitRatio =
      hasCacheTokens
        ? m.cacheTokens.read /
          (m.cacheTokens.read + m.cacheTokens.creation + m.totalTokens.prompt)
        : 0;

    const filterOptions: { value: SourceFilter; label: string }[] = [
      { value: "all", label: "All" },
      { value: "copilot", label: "Copilot" },
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
    ];

    const scopeOptions: { value: TimeScope; label: string }[] = [
      { value: "all", label: "All time" },
      { value: "today", label: "Today" },
      { value: "last-hour", label: "Last hour" },
    ];

    const sessionActive = this.activeSession !== null;
    const providerLabel = (p: string) =>
      p === "copilot" ? "Copilot" : p === "claude" ? "Claude" : "Codex";

    // Derive unique project names, current workspace first
    const projectSet = new Set<string>();
    let hasCurrentProject = false;
    for (const s of this.sessions) {
      if (s.projectName) projectSet.add(s.projectName);
      if (s.isCurrentWorkspace) hasCurrentProject = true;
    }
    const projectNames = [...projectSet].sort((a, b) => a.localeCompare(b));
    const hasProjects = projectNames.length > 0;

    // Scope session list to selected project
    const projectSessions = this.activeProject !== null
      ? this.sessions.filter((s) => (s.projectName ?? "Other") === this.activeProject)
      : this.sessions;
    const sortedSessions = [...projectSessions].sort(
      (a, b) => b.lastActivity - a.lastActivity,
    );

    return html`
      <div class="header-row">
        <h1>Agent Lens Metrics</h1>
        <div class="token-guide">
          <button
            class="guide-toggle"
            @click="${() => { this.guideOpen = !this.guideOpen; }}"
          >
            ${this.guideOpen ? "Hide" : "Show"} Token Guide
          </button>
        </div>
      </div>
      ${this.guideOpen ? this.renderTokenGuide() : null}
      <div class="toolbar">
        <div class="filter-toggle ${sessionActive ? "inactive" : ""}">
          ${filterOptions.map(
            (opt) => html`
              <button
                class="filter-btn ${this.activeFilter === opt.value ? "active" : ""}"
                @click="${() => this.onFilterChange(opt.value)}"
              >
                ${opt.label}
              </button>
            `,
          )}
        </div>
        <div class="filter-toggle ${sessionActive ? "inactive" : ""}">
          ${scopeOptions.map(
            (opt) => html`
              <button
                class="filter-btn ${this.activeScope === opt.value ? "active" : ""}"
                @click="${() => this.onScopeChange(opt.value)}"
              >
                ${opt.label}
              </button>
            `,
          )}
        </div>
        ${hasProjects ? html`
          <select
            class="session-select ${sessionActive ? "inactive" : ""}"
            .value="${this.activeProject ?? ""}"
            @change="${this.onProjectChange}"
            ?disabled="${sessionActive}"
          >
            <option value="">All projects</option>
            ${hasCurrentProject ? html`<option value="__current__">Current project</option>` : null}
            ${projectNames.map((p) => html`<option value="${p}">${p}</option>`)}
          </select>
        ` : null}
        <select
          class="session-select"
          .value="${this.activeSession ?? ""}"
          @change="${this.onSessionChange}"
        >
          <option value="">All sessions</option>
          ${sortedSessions.map((s) => html`
            <option value="${s.sessionId}">
              ${providerLabel(s.provider)} — ${s.title ?? new Date(s.creationDate).toLocaleString()}
            </option>
          `)}
        </select>
      </div>

      <div class="stats-grid">
        <div class="stat-card" title="Total number of chat sessions with at least 1 request">
          <div class="stat-value">${m.totalSessions}</div>
          <div class="stat-label">Sessions</div>
          ${this.emptyCount > 0
            ? html`<div class="stat-note">${this.emptyCount} empty hidden</div>`
            : null}
        </div>
        <div class="stat-card" title="Total API round-trips (each assistant response counts as one request)">
          <div class="stat-value">${m.totalRequests}</div>
          <div class="stat-label">Requests</div>
        </div>
        <div class="stat-card" title="All tokens processed: input + output + cached. This is the total volume sent to/from the model.">
          <div class="stat-value">
            ${this.formatNumber(m.totalTokens.prompt + m.totalTokens.completion + m.cacheTokens.read + m.cacheTokens.creation)}
          </div>
          <div class="stat-label">Total Tokens</div>
        </div>
        <div class="stat-card" title="Output tokens generated by the model. Billed at the full output rate.">
          <div class="stat-value">
            ${this.formatNumber(m.totalTokens.completion)}
          </div>
          <div class="stat-label">Output Tokens</div>
          ${this.activeFilter === "copilot"
            ? html`<div class="stat-cost free">included</div>`
            : html`<div class="stat-cost full">full price</div>`}
        </div>
        <div class="stat-card" title="Non-cached input tokens. These are billed at the full input rate.">
          <div class="stat-value">
            ${this.formatNumber(m.totalTokens.prompt)}
          </div>
          <div class="stat-label">Input Tokens</div>
          ${this.activeFilter === "copilot"
            ? html`<div class="stat-cost free">included</div>`
            : html`<div class="stat-cost full">full price</div>`}
        </div>
        ${hasCacheTokens
          ? html`
              <div class="stat-card" title="Input tokens served from the prompt cache. Billed at 1/10th the input rate (90% savings).">
                <div class="stat-value">
                  ${this.formatNumber(m.cacheTokens.read)}
                </div>
                <div class="stat-label">Cache Read Tokens</div>
                <div class="stat-cost cheap">0.1x price</div>
              </div>
              <div class="stat-card" title="Input tokens written to the prompt cache for future reuse. Billed at 1.25x the input rate.">
                <div class="stat-value">
                  ${this.formatNumber(m.cacheTokens.creation)}
                </div>
                <div class="stat-label">Cache Creation Tokens</div>
                <div class="stat-cost premium">1.25x price</div>
              </div>
              <div class="stat-card" title="Percentage of input tokens served from cache. Higher = more savings.">
                <div class="stat-value">
                  ${Math.round(cacheHitRatio * 100)}%
                </div>
                <div class="stat-label">Cache Hit Ratio</div>
              </div>
            `
          : null}
      </div>

      <h2>Token Distribution</h2>
      <div class="donut-row">
        <div class="donut-card">
          <div class="donut-title">By Agent</div>
          ${this.renderDonutChart(agentSlices)}
        </div>
        <div class="donut-card">
          <div class="donut-title">By Model</div>
          ${this.renderDonutChart(modelSlices)}
        </div>
        <div class="donut-card">
          <div class="donut-title">Prompt vs Completion</div>
          ${this.renderDonutChart(promptCompSlices)}
        </div>
        ${hasCacheTokens
          ? html`
              <div class="donut-card">
                <div class="donut-title">Input Token Breakdown</div>
                ${this.renderDonutChart(cacheInputSlices)}
              </div>
            `
          : null}
      </div>

      <h2>Agent Usage</h2>
      ${this.renderBarChart(m.agentUsage, "#c4a882", 10, agentTooltipData)}

      <h2>Model Usage</h2>
      ${this.renderBarChart(m.modelUsage, "#b09090")}

      <h2>Tool Calls</h2>
      ${this.renderBarChart(m.toolUsage, "#c9b87c")}

      ${m.mcpServerUsage.length > 0
        ? html`
            <h2>MCP Servers</h2>
            ${this.renderBarChart(m.mcpServerUsage, "#82aac4")}
          `
        : null}

      <h2>Skill Usage</h2>
      ${this.renderBarChart(m.skillUsage, "#8aab7f")}

      ${m.unusedAgents.length > 0 || m.unusedSkills.length > 0
        ? html`
            <h2>Unused</h2>
            ${this.renderUnusedSection("Agents", m.unusedAgents)}
            ${this.renderUnusedSection("Skills", m.unusedSkills)}
          `
        : null}
      ${this.tooltip
        ? html`<div
            class="tooltip"
            style="left: ${this.tooltip.x}px; top: ${this.tooltip.y}px; white-space: pre-line;"
          ><strong>${this.tooltip.name}</strong>\n${this.tooltip.detail}</div>`
        : null}
    `;
  }
}
