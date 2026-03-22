export interface SessionRequest {
  requestId: string;
  timestamp: number;
  agentId: string;
  customAgentName: string | null;
  modelId: string;
  messageText: string;
  timings: {
    firstProgress: number | null;
    totalElapsed: number | null;
  };
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

export interface ToolCallInfo {
  id: string;
  name: string;
  subagentDescription?: string;
  childToolCalls?: ToolCallInfo[];
  mcpServer?: string;
}

export interface SkillRef {
  name: string;
  file: string;
}

export type SessionProviderType = "copilot" | "claude" | "codex";

export type SessionScope = "workspace" | "fallback";

export interface Session {
  sessionId: string;
  title: string | null;
  creationDate: number;
  requests: SessionRequest[];
  source: string;
  provider: SessionProviderType;
  scope?: SessionScope;
  matchedWorkspace?: string;
  /** vscode.env.remoteName at the time of discovery, e.g. "ssh-remote", "dev-container", null for local */
  environment?: string | null;
  /** Human-readable project name, e.g. "agent-lens", "pi-zero-hw-management" */
  projectName?: string;
  /** true when the session belongs to the currently open VS Code workspace */
  isCurrentWorkspace?: boolean;
}
