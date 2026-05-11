import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./timeline.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

type SourceFilter = "all" | "copilot" | "claude" | "codex";
type ScopeFilter = "all-projects" | "current-project";

interface ToolCallInfo {
  id: string;
  name: string;
  subagentDescription?: string;
  childToolCalls?: ToolCallInfo[];
  mcpServer?: string;
}

interface SkillRef {
  name: string;
  file: string;
}

interface SessionRequest {
  requestId: string;
  timestamp: number;
  agentId: string;
  customAgentName: string | null;
  modelId: string;
  messageText: string;
  timings: { firstProgress: number | null; totalElapsed: number | null };
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  toolCalls: ToolCallInfo[];
  availableSkills: SkillRef[];
  loadedSkills: string[];
  isSubagent?: boolean;
  parentRequestId?: string;
  subagentId?: string;
}

interface Session {
  sessionId: string;
  title: string | null;
  creationDate: number;
  requests: SessionRequest[];
  source: string;
  provider: "copilot" | "claude" | "codex";
  scope?: "workspace" | "fallback";
  matchedWorkspace?: string;
  environment?: string | null;
  projectName?: string;
  isCurrentWorkspace?: boolean;
}

@customElement("session-explorer")
class SessionExplorer extends LitElement {
  static styles = css`
    :host {
      display: block;
      max-width: 900px;
      margin: 0 auto;
    }
    h1 {
      font-size: 20px;
      margin: 0 0 16px;
      font-weight: 500;
    }
    h2 {
      font-size: 16px;
      margin: 0 0 12px;
      font-weight: 500;
    }

    /* Session picker */
    .session-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 24px;
    }
    .session-item {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    .session-item:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .session-item.selected {
      border-color: var(--vscode-focusBorder, #007fd4);
      background: var(--vscode-list-activeSelectionBackground, #04395e);
    }
    .session-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-meta {
      font-size: 11px;
      opacity: 0.6;
      margin-left: 12px;
      white-space: nowrap;
    }
    .back-header {
      position: sticky;
      top: 0;
      z-index: 12;
      background: var(--vscode-editor-background, #1e1e1e);
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
    }
    .back-btn {
      background: none;
      border: 1px solid var(--vscode-button-border, #555);
      color: var(--vscode-button-foreground, #fff);
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      flex-shrink: 0;
    }
    .back-btn:hover {
      background: var(--vscode-button-hoverBackground, #333);
    }
    .back-header-title {
      font-size: 13px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.7;
    }

    /* Sticky timeline chart */
    .timeline-sticky {
      position: sticky;
      top: 34px;
      z-index: 10;
      background: var(--vscode-editor-background, #1e1e1e);
      padding-bottom: 8px;
    }

    /* Timeline */
    .timeline {
      position: relative;
      padding-left: 24px;
    }
    .timeline::before {
      content: "";
      position: absolute;
      left: 8px;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--vscode-editorWidget-border, #454545);
    }
    .timeline-entry {
      position: relative;
      margin-bottom: 8px;
      padding: 10px 12px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 6px;
      cursor: pointer;
    }
    .timeline-entry:hover {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .timeline-entry::before {
      content: "";
      position: absolute;
      left: -20px;
      top: 16px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #c4a882;
      border: 2px solid var(--vscode-editor-background, #1e1e1e);
    }
    .timeline-entry.agent-switch::before {
      background: #b09090;
    }
    .timeline-entry.model-switch::before {
      background: #c9b87c;
    }
    .entry-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      font-size: 12px;
    }
    .entry-agent {
      font-weight: 600;
      color: #c4a882;
    }
    .entry-model {
      opacity: 0.6;
    }
    .entry-time {
      margin-left: auto;
      opacity: 0.5;
      font-size: 11px;
    }
    .entry-prompt {
      font-size: 13px;
      line-height: 1.4;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .entry-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
    }
    .tool-tag {
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #ccc);
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
    }
    .tool-tag.subagent-call {
      background: rgba(138, 171, 127, 0.25);
      color: #8aab7f;
    }
    .tool-tag.mcp-tool {
      background: rgba(130, 170, 196, 0.25);
      color: #82aac4;
    }
    .mcp-server-badge {
      font-size: 9px;
      opacity: 0.7;
      margin-left: 2px;
    }
    .subagent-detail {
      margin-top: 4px;
      padding: 8px;
      background: rgba(138, 171, 127, 0.08);
      border-left: 2px solid #8aab7f;
      border-radius: 0 4px 4px 0;
    }
    .subagent-detail .subagent-desc {
      font-size: 12px;
      color: #8aab7f;
      margin-bottom: 4px;
    }
    .subagent-detail .child-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
    }
    .subagent-detail .child-tool {
      font-size: 10px;
      opacity: 0.7;
    }
    .entry-stats {
      display: flex;
      gap: 12px;
      margin-top: 6px;
      font-size: 11px;
      opacity: 0.5;
    }
    .switch-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 600;
    }
    .switch-badge.agent {
      background: rgba(176, 144, 144, 0.2);
      color: #b09090;
    }
    .switch-badge.model {
      background: rgba(201, 184, 124, 0.2);
      color: #c9b87c;
    }
    .timeline-entry.subagent::before {
      background: #8aab7f;
    }
    .switch-badge.subagent {
      background: rgba(138, 171, 127, 0.2);
      color: #8aab7f;
    }

    /* Detail view */
    .detail-overlay {
      margin-top: 8px;
      padding: 8px 10px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 4px;
    }
    .detail-section {
      margin-bottom: 6px;
    }
    .detail-section:last-child {
      margin-bottom: 0;
    }
    .detail-section h3 {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.5;
      margin: 0 0 2px;
    }
    .detail-text {
      font-size: 12px;
      line-height: 1.4;
      word-break: break-word;
    }
    .detail-text.pre {
      white-space: pre-wrap;
    }
    .empty-state {
      opacity: 0.5;
      font-style: italic;
      font-size: 13px;
      padding: 24px 0;
      text-align: center;
    }
    .empty-notice {
      font-size: 12px;
      opacity: 0.5;
      text-align: center;
      padding: 8px 0;
      font-style: italic;
    }
    .filter-toggle {
      display: inline-flex;
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 16px;
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
    .scope-toggle {
      display: inline-flex;
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 16px;
      margin-left: 12px;
    }
    .project-group-header {
      font-size: 13px;
      font-weight: 600;
      padding: 12px 0 6px;
      opacity: 0.7;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .project-group-header .current-marker {
      font-size: 10px;
      font-weight: 500;
      opacity: 0.6;
    }
    .project-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 500;
      margin-right: 6px;
      flex-shrink: 0;
      background: rgba(130, 170, 196, 0.12);
      color: var(--vscode-descriptionForeground, #8b8b8b);
    }
    .provider-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 600;
      margin-right: 8px;
      flex-shrink: 0;
    }
    .provider-badge.copilot {
      background: rgba(196, 168, 130, 0.15);
      color: #c4a882;
    }
    .provider-badge.claude {
      background: rgba(176, 144, 144, 0.15);
      color: #b09090;
    }
    .provider-badge.codex {
      background: rgba(138, 171, 127, 0.15);
      color: #8aab7f;
    }
    .env-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 500;
      margin-right: 6px;
      flex-shrink: 0;
      background: rgba(160, 160, 160, 0.1);
      color: var(--vscode-descriptionForeground, #8b8b8b);
    }
    .recovered-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 500;
      margin-right: 6px;
      flex-shrink: 0;
      background: rgba(201, 184, 124, 0.12);
      color: var(--vscode-descriptionForeground, #8b8b8b);
    }
    .agent-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 500;
      margin-right: 6px;
      flex-shrink: 0;
      background: rgba(176, 144, 144, 0.12);
      color: var(--vscode-descriptionForeground, #8b8b8b);
    }
    .skills-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 500;
      margin-right: 6px;
      flex-shrink: 0;
      background: rgba(138, 171, 127, 0.12);
      color: var(--vscode-descriptionForeground, #8b8b8b);
    }
  `;

  @state() private sessions: Session[] = [];
  @state() private emptyCount = 0;
  @state() private activeFilter: SourceFilter = "all";
  @state() private scopeFilter: ScopeFilter = "all-projects";
  @state() private selectedSession: Session | null = null;
  @state() private selectedRequest: SessionRequest | null = null;
  @state() private customAgentNames: string[] = [];
  @state() private hasProjectMetadata = false;
  @state() private isScanning = false;
  @state() private hasReceivedFirstUpdate = false;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.handleMessage);
    vscode.postMessage({ type: "ready" });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("message", this.handleMessage);
  }

  private handleMessage = (e: MessageEvent): void => {
    if (e.data.type === "scan-state") {
      this.isScanning = e.data.state === "scanning";
    }
    if (e.data.type === "update-sessions") {
      this.hasReceivedFirstUpdate = true;
      this.sessions = e.data.sessions;
      this.emptyCount = e.data.emptyCount ?? 0;
      if (e.data.activeFilter) {
        this.activeFilter = e.data.activeFilter;
      }
      if (e.data.customAgentNames) {
        this.customAgentNames = e.data.customAgentNames;
      }
      if (typeof e.data.hasProjectMetadata === "boolean") {
        this.hasProjectMetadata = e.data.hasProjectMetadata;
      }

      // Keep the selected session/request in sync with fresh data
      if (this.selectedSession) {
        const updated = this.sessions.find(
          (s) => s.sessionId === this.selectedSession!.sessionId,
        );
        if (updated) {
          this.selectedSession = updated;
          if (this.selectedRequest) {
            this.selectedRequest =
              updated.requests.find(
                (r) => r.requestId === this.selectedRequest!.requestId,
              ) ?? null;
          }
        }
      }
    }
  };

  private onFilterChange(filter: SourceFilter): void {
    this.activeFilter = filter;
    vscode.postMessage({ type: "filter-change", provider: filter });
  }

  private onScopeChange(scope: ScopeFilter): void {
    this.scopeFilter = scope;
    vscode.postMessage({ type: "scope-change", scope });
  }

  private renderProjectBadge(session: Session) {
    if (!session.projectName) return null;
    const label = session.isCurrentWorkspace
      ? `${session.projectName} (current)`
      : session.projectName;
    return html`<span class="project-badge" title="Project: ${session.projectName}">${label}</span>`;
  }

  private formatDate(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  private safeDecode(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private summarizeWorkspaceMatch(workspaceUri?: string): string {
    if (!workspaceUri) return "workspace match";

    if (workspaceUri.startsWith("file://")) {
      const pathValue = this.safeDecode(workspaceUri.slice("file://".length));
      const cleaned = pathValue.replace(/\/+$/, "");
      const idx = cleaned.lastIndexOf("/");
      return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
    }

    if (workspaceUri.startsWith("vscode-remote://")) {
      const decoded = this.safeDecode(workspaceUri);
      const sshPrefix = "vscode-remote://ssh-remote+";
      if (decoded.startsWith(sshPrefix)) {
        const rest = decoded.slice(sshPrefix.length);
        const slash = rest.indexOf("/");
        return slash >= 0 ? `ssh:${rest.slice(0, slash)}` : `ssh:${rest}`;
      }
      if (decoded.includes("dev-container")) {
        return "dev-container";
      }
      return "remote workspace";
    }

    const cleaned = workspaceUri.replace(/\/+$/, "");
    const idx = cleaned.lastIndexOf("/");
    return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
  }

  private renderEnvBadge(session: Session) {
    const env = session.environment;
    if (!env) return null;

    let label = env;
    if (env === "ssh-remote") label = "SSH";
    else if (env === "dev-container") label = "container";
    else if (env === "wsl") label = "WSL";

    return html`<span class="env-badge" title="Recorded in: ${env}">${label}</span>`;
  }

  private renderRecoveredBadge(session: Session) {
    if (session.scope !== "fallback") return null;
    const tip = session.matchedWorkspace
      ? `Recovered from stale hash: ${session.matchedWorkspace}`
      : "Recovered from a previous workspace hash — may not appear in Copilot Chat history";
    return html`<span class="recovered-badge" title="${tip}">recovered</span>`;
  }

  private renderAgentBadge(session: Session) {
    const names = new Set(
      session.requests
        .map((r) => r.customAgentName)
        .filter((n): n is string => n !== null),
    );
    if (names.size === 0) return null;
    const list = [...names];
    const label = names.size === 1 ? `@${list[0]}` : `${names.size} agents`;
    const tip =
      names.size === 1
        ? `Custom agent: ${list[0]}`
        : `Custom agents: ${list.join(", ")}`;
    return html`<span class="agent-badge" title="${tip}">${label}</span>`;
  }

  private renderSkillsBadge(session: Session) {
    const max = Math.max(0, ...session.requests.map((r) => r.availableSkills.length));
    if (max === 0) return null;
    return html`<span class="skills-badge" title="${max} Copilot skill${max === 1 ? "" : "s"} available">${max} copilot skill${max === 1 ? "" : "s"}</span>`;
  }

  private workspaceMatchIcon(workspaceUri?: string): string {
    if (!workspaceUri) return "◌";
    if (workspaceUri.startsWith("file://")) return "⌂";

    if (workspaceUri.startsWith("vscode-remote://")) {
      const decoded = this.safeDecode(workspaceUri);
      if (decoded.startsWith("vscode-remote://ssh-remote+")) return "⇄";
      if (decoded.includes("dev-container")) return "⬢";
      return "☁";
    }

    return "◌";
  }

  private summarizeChildTools(children: ToolCallInfo[]): [string, number][] {
    const counts = new Map<string, number>();
    for (const c of children) {
      counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }

  private renderDetailToolCalls(toolCalls: ToolCallInfo[]) {
    // Group tools: subagents first, then by MCP server, then built-in
    const subagents = toolCalls.filter(
      (tc) => tc.childToolCalls && tc.childToolCalls.length > 0,
    );
    const mcpByServer = new Map<string, ToolCallInfo[]>();
    const builtIn: ToolCallInfo[] = [];

    for (const tc of toolCalls) {
      if (tc.childToolCalls && tc.childToolCalls.length > 0) continue;
      if (tc.mcpServer) {
        let list = mcpByServer.get(tc.mcpServer);
        if (!list) {
          list = [];
          mcpByServer.set(tc.mcpServer, list);
        }
        list.push(tc);
      } else {
        builtIn.push(tc);
      }
    }

    return html`
      ${subagents.map(
        (tc) => html`
          <div class="detail-text">${tc.name}</div>
          <div class="subagent-detail">
            ${tc.subagentDescription
              ? html`<div class="subagent-desc">${tc.subagentDescription}</div>`
              : null}
            <div class="child-tools">
              ${this.summarizeChildTools(tc.childToolCalls!).map(
                ([name, count]) => html`
                  <span class="tool-tag child-tool">${name}${count > 1 ? ` x${count}` : ""}</span>
                `,
              )}
            </div>
          </div>
        `,
      )}
      ${Array.from(mcpByServer.entries()).map(
        ([server, tools]) => html`
          <div class="detail-text" style="margin-top: 4px; color: #82aac4; font-size: 11px;">MCP: ${server}</div>
          ${tools.map((tc) => html`<div class="detail-text" style="padding-left: 12px;">${tc.name}</div>`)}
        `,
      )}
      ${builtIn.map((tc) => html`<div class="detail-text">${tc.name}</div>`)}
    `;
  }

  private formatDuration(ms: number | null): string {
    if (ms === null) return "-";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  private renderSessionList() {
    const sorted = [...this.sessions].sort(
      (a, b) => b.creationDate - a.creationDate,
    );

    // Check if we have project metadata (global discovery is active).
    // Use the unfiltered flag from the extension so the scope toggle stays
    // visible even when the current-project filter yields zero results.
    const hasProjects = this.hasProjectMetadata;

    const filtered = sorted;

    const filterOptions: { value: SourceFilter; label: string }[] = [
      { value: "all", label: "All" },
      { value: "copilot", label: "Copilot" },
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
    ];

    const scopeOptions: { value: ScopeFilter; label: string }[] = [
      { value: "all-projects", label: "All Projects" },
      { value: "current-project", label: "Current Project" },
    ];

    // Group sessions by project for display
    const groups = hasProjects ? this.groupByProject(filtered) : null;

    return html`
      <div style="display: flex; align-items: center; flex-wrap: wrap;">
        <div class="filter-toggle">
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
        ${hasProjects
          ? html`
              <div class="scope-toggle">
                ${scopeOptions.map(
                  (opt) => html`
                    <button
                      class="filter-btn ${this.scopeFilter === opt.value ? "active" : ""}"
                      @click="${() => this.onScopeChange(opt.value)}"
                    >
                      ${opt.label}
                    </button>
                  `,
                )}
              </div>
            `
          : null}
      </div>
      <h1>Session Explorer</h1>
      ${filtered.length === 0
        ? html`<div class="empty-state">
            ${this.isScanning || !this.hasReceivedFirstUpdate
              ? "Scanning sessions…"
              : "No sessions found. Sessions are auto-discovered from VS Code workspace storage."}
          </div>`
        : groups
          ? this.renderGroupedSessions(groups)
          : html`
              <div class="session-list">
                ${filtered.map((session) => this.renderSessionItem(session))}
              </div>
            `}
      ${this.emptyCount > 0
        ? html`<div class="empty-notice">
            ${this.emptyCount} empty session${this.emptyCount === 1 ? "" : "s"} hidden (0 requests)
          </div>`
        : null}
    `;
  }

  private groupByProject(
    sessions: Session[],
  ): { name: string; isCurrent: boolean; sessions: Session[] }[] {
    const map = new Map<string, { isCurrent: boolean; sessions: Session[] }>();
    const ungrouped: Session[] = [];

    for (const s of sessions) {
      if (s.projectName) {
        let group = map.get(s.projectName);
        if (!group) {
          group = { isCurrent: s.isCurrentWorkspace === true, sessions: [] };
          map.set(s.projectName, group);
        }
        group.sessions.push(s);
      } else {
        ungrouped.push(s);
      }
    }

    // Sort: current workspace first, then alphabetical
    const groups = Array.from(map.entries())
      .map(([name, g]) => ({ name, ...g }))
      .sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    // Add ungrouped sessions as a catch-all group
    if (ungrouped.length > 0) {
      groups.push({ name: "Other", isCurrent: false, sessions: ungrouped });
    }

    return groups;
  }

  private renderGroupedSessions(
    groups: { name: string; isCurrent: boolean; sessions: Session[] }[],
  ) {
    return html`
      ${groups.map(
        (group) => html`
          <div class="project-group-header">
            ${group.name}
            ${group.isCurrent
              ? html`<span class="current-marker">(current)</span>`
              : null}
            <span class="current-marker"
              >${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"}</span
            >
          </div>
          <div class="session-list">
            ${group.sessions.map((session) => this.renderSessionItem(session))}
          </div>
        `,
      )}
    `;
  }

  private renderSessionItem(session: Session) {
    return html`
      <div
        class="session-item"
        @click="${() => {
          this.selectedSession = session;
          this.selectedRequest = null;
        }}"
      >
        <span class="provider-badge ${session.provider}">
          ${session.provider === "copilot"
            ? "Copilot"
            : session.provider === "claude"
              ? "Claude"
              : "Codex"}
        </span>
        ${this.renderProjectBadge(session)} ${this.renderEnvBadge(session)}
        ${this.renderRecoveredBadge(session)} ${this.renderAgentBadge(session)}
        ${this.renderSkillsBadge(session)}
        <span class="session-title">
          ${session.title ?? session.sessionId}
        </span>
        <span class="session-meta"> ${session.requests.length} requests </span>
        <span class="session-meta">
          ${this.formatDate(session.creationDate)}
        </span>
      </div>
    `;
  }

  private renderTimeline(session: Session) {
    return html`
      <div class="back-header">
        <button
          class="back-btn"
          @click="${() => {
            this.selectedSession = null;
            this.selectedRequest = null;
          }}"
        >
          Back to sessions
        </button>
        <span class="back-header-title">${session.title ?? session.sessionId}</span>
      </div>

      <div class="timeline-sticky">
        <session-timeline
          .requests="${session.requests.map((req) => ({
            ...req,
            mcpToolCalls: req.toolCalls
              .filter((tc) => tc.mcpServer)
              .map((tc) => ({ name: tc.name, server: tc.mcpServer! })),
          }))}"
          .customAgentNames="${this.customAgentNames}"
          .selectedRequestId="${this.selectedRequest?.requestId ?? null}"
          @request-select="${(e: CustomEvent) => {
            const reqId = e.detail;
            const req = session.requests.find((r) => r.requestId === reqId);
            this.selectedRequest =
              this.selectedRequest?.requestId === reqId ? null : (req ?? null);
            // Scroll to the corresponding entry in the list
            requestAnimationFrame(() => {
              const el = this.renderRoot.querySelector(`#req-${CSS.escape(reqId)}`);
              if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
            });
          }}"
        ></session-timeline>
      </div>

      <div class="timeline">
        ${session.requests.map((req, i) => {
          const prev = i > 0 ? session.requests[i - 1] : null;
          const agentName = req.customAgentName ?? req.agentId;
          const prevAgent = prev
            ? prev.customAgentName ?? prev.agentId
            : null;
          const isSubagent = req.isSubagent === true;
          const agentSwitch =
            prev !== null && agentName !== prevAgent && !isSubagent;
          const modelSwitch =
            prev !== null && req.modelId !== prev.modelId;

          return html`
            <div
              id="req-${req.requestId}"
              class="timeline-entry ${isSubagent ? "subagent" : ""} ${agentSwitch ? "agent-switch" : ""} ${modelSwitch ? "model-switch" : ""}"
              @click="${() => {
                this.selectedRequest =
                  this.selectedRequest?.requestId === req.requestId
                    ? null
                    : req;
              }}"
            >
              <div class="entry-header">
                <span class="entry-agent">${agentName}</span>
                ${isSubagent
                  ? html`<span class="switch-badge subagent">subagent</span>`
                  : null}
                ${agentSwitch
                  ? html`<span class="switch-badge agent">agent switch</span>`
                  : null}
                ${modelSwitch
                  ? html`<span class="switch-badge model">model switch</span>`
                  : null}
                <span class="entry-model">${req.modelId}</span>
                <span class="entry-time"
                  >${this.formatDate(req.timestamp)}</span
                >
              </div>
              ${req.messageText
                ? html`<div class="entry-prompt">${req.messageText}</div>`
                : null}
              ${req.toolCalls.length > 0
                ? html`
                    <div class="entry-tools">
                      ${req.toolCalls.map(
                        (tc) =>
                          tc.childToolCalls && tc.childToolCalls.length > 0
                            ? html`<span class="tool-tag subagent-call">${tc.name} (${tc.childToolCalls.length} tools)</span>`
                            : tc.mcpServer
                              ? html`<span class="tool-tag mcp-tool">${tc.name}<span class="mcp-server-badge">(${tc.mcpServer})</span></span>`
                              : html`<span class="tool-tag">${tc.name}</span>`,
                      )}
                    </div>
                  `
                : null}
              <div class="entry-stats">
                <span>${this.formatDuration(req.timings.totalElapsed)}</span>
                <span>${(req.usage.promptTokens + req.usage.completionTokens + (req.usage.cacheReadTokens ?? 0) + (req.usage.cacheCreationTokens ?? 0)).toLocaleString()} tokens</span>
              </div>
              ${this.selectedRequest?.requestId === req.requestId
                ? this.renderRequestDetail(req)
                : null}
            </div>
          `;
        })}
      </div>
    `;
  }

  private renderRequestDetail(req: SessionRequest) {
    const cacheRead = req.usage.cacheReadTokens ?? 0;
    const cacheCreate = req.usage.cacheCreationTokens ?? 0;
    const timingLine = html`First token: ${this.formatDuration(req.timings.firstProgress)}<br>Total: ${this.formatDuration(req.timings.totalElapsed)}`;
    const tokenLine = html`Prompt: ${req.usage.promptTokens.toLocaleString()}<br>Completion: ${req.usage.completionTokens.toLocaleString()}${cacheCreate > 0 ? html`<br>Cache create: ${cacheCreate.toLocaleString()}` : null}${cacheRead > 0 ? html`<br>Cache read: ${cacheRead.toLocaleString()}` : null}`;

    return html`
      <div class="detail-overlay" @click="${(e: Event) => e.stopPropagation()}">
        ${req.messageText
          ? html`<div class="detail-section">
              <h3>Prompt</h3>
              <div class="detail-text pre">${req.messageText}</div>
            </div>`
          : null}
        ${req.toolCalls.length > 0
          ? html`<div class="detail-section">
              <h3>Tool Calls (${req.toolCalls.length})</h3>
              ${this.renderDetailToolCalls(req.toolCalls)}
            </div>`
          : null}
        ${req.loadedSkills.length > 0
          ? html`<div class="detail-section">
              <h3>Loaded Skills</h3>
              ${req.loadedSkills.map((s) => html`<div class="detail-text">${s}</div>`)}
            </div>`
          : null}
        <div class="detail-section">
          <h3>Timing</h3>
          <div class="detail-text">${timingLine}</div>
        </div>
        <div class="detail-section">
          <h3>Tokens</h3>
          <div class="detail-text">${tokenLine}</div>
        </div>
      </div>
    `;
  }

  protected render() {
    if (this.selectedSession) {
      return this.renderTimeline(this.selectedSession);
    }
    return this.renderSessionList();
  }
}
