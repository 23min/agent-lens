import * as vscode from "vscode";
import type { Agent } from "./models/agent.js";
import type { Skill } from "./models/skill.js";
import type { Session } from "./models/session.js";
import { discoverAgents, discoverSkills } from "./parsers/discovery.js";
import {
  registerSessionProvider,
  discoverAllSessions,
  collectWatchTargets,
} from "./parsers/sessionRegistry.js";
import type { SessionDiscoveryContext } from "./parsers/sessionProvider.js";
import { CopilotSessionProvider } from "./parsers/copilotProvider.js";
import { ClaudeSessionProvider } from "./parsers/claudeProvider.js";
import { CodexSessionProvider } from "./parsers/codexProvider.js";
import { buildGraph } from "./analyzers/graphBuilder.js";
import { AgentLensTreeProvider } from "./views/treeProvider.js";
import { initLogger, getLogger } from "./logger.js";
import { GraphPanel } from "./views/graphPanel.js";
import { MetricsPanel } from "./views/metricsPanel.js";
import { SessionPanel } from "./views/sessionPanel.js";
import { SetupPanel } from "./views/setupPanel.js";
import { collectDiagnostics, formatDiagnosticReport } from "./diagnostics.js";
import * as os from "node:os";

let cachedAgents: Agent[] = [];
let cachedSkills: Skill[] = [];
let cachedSessions: Session[] = [];

let refreshing = false;
let refreshQueued = false;

async function refresh(
  sessionCtx: SessionDiscoveryContext,
  treeProvider: AgentLensTreeProvider,
): Promise<void> {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;

  const log = getLogger();
  const start = Date.now();
  log.debug("Refresh started");

  try {
    const [agents, skills, sessions] = await Promise.all([
      discoverAgents(),
      discoverSkills(),
      discoverAllSessions(sessionCtx),
    ]);
    cachedAgents = agents;
    cachedSkills = skills;
    cachedSessions = sessions;

    // Tag every session with the current environment so the UI can badge them
    const environment = vscode.env.remoteName ?? null;
    for (const s of cachedSessions) {
      s.environment = environment;
    }

    // Detect remote/container context with no sessions
    const isRemote = !!vscode.env.remoteName;
    const remoteNoSessions = isRemote && sessions.length === 0;
    void vscode.commands.executeCommand(
      "setContext",
      "agentLens.isRemoteNoSessions",
      remoteNoSessions,
    );

    treeProvider.update(agents, skills, { remoteNoSessions });

    // Push fresh data to any open panels (without stealing focus)
    GraphPanel.updateIfOpen(buildGraph(agents, skills));
    MetricsPanel.updateIfOpen(
      sessions,
      agents.map((a) => ({ name: a.name, provider: a.provider })),
      skills.map((s) => ({ name: s.name, provider: s.provider })),
    );
    SessionPanel.updateIfOpen(sessions, agents.map((a) => a.name));

    const elapsed = Date.now() - start;
    const nonEmpty = sessions.filter((s) => s.requests.length > 0).length;
    log.info(
      `Refresh complete in ${elapsed}ms — ${agents.length} agents, ${skills.length} skills, ${sessions.length} sessions (${nonEmpty} non-empty)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Refresh failed: ${msg}`);
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refresh(sessionCtx, treeProvider);
    }
  }
}

async function refreshWithProgress(
  sessionCtx: SessionDiscoveryContext,
  treeProvider: AgentLensTreeProvider,
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Agent Lens: Scanning sessions\u2026",
    },
    () => refresh(sessionCtx, treeProvider),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Agent Lens", { log: true });
  initLogger(outputChannel);
  const version = context.extension.packageJSON.version ?? "unknown";
  getLogger().info(`Agent Lens v${version} activated`);

  // Register session providers
  registerSessionProvider(new CopilotSessionProvider());
  registerSessionProvider(new ClaudeSessionProvider());
  registerSessionProvider(new CodexSessionProvider());

  const sessionCtx: SessionDiscoveryContext = {
    extensionContext: context,
    workspacePath:
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
  };

  const treeProvider = new AgentLensTreeProvider();
  const treeView = vscode.window.createTreeView("agentLens.treeView", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const refreshCmd = vscode.commands.registerCommand(
    "agentLens.refresh",
    () => refresh(sessionCtx, treeProvider),
  );

  const showGraph = vscode.commands.registerCommand(
    "agentLens.showGraph",
    async () => {
      await refreshWithProgress(sessionCtx, treeProvider);
      const graph = buildGraph(cachedAgents, cachedSkills);
      GraphPanel.show(context.extensionUri, graph);
    },
  );

  const openMetrics = vscode.commands.registerCommand(
    "agentLens.openMetrics",
    async () => {
      await refreshWithProgress(sessionCtx, treeProvider);
      MetricsPanel.show(
        context.extensionUri,
        cachedSessions,
        cachedAgents.map((a) => ({ name: a.name, provider: a.provider })),
        cachedSkills.map((s) => ({ name: s.name, provider: s.provider })),
      );
    },
  );

  const openSession = vscode.commands.registerCommand(
    "agentLens.openSession",
    async () => {
      await refreshWithProgress(sessionCtx, treeProvider);
      SessionPanel.show(
        context.extensionUri,
        cachedSessions,
        cachedAgents.map((a) => a.name),
      );
    },
  );

  const openContainerSetup = vscode.commands.registerCommand(
    "agentLens.openContainerSetup",
    () => {
      SetupPanel.show(context.extensionUri);
    },
  );

  const diagnoseCmd = vscode.commands.registerCommand(
    "agentLens.diagnoseDiscovery",
    async () => {
      const config = vscode.workspace.getConfiguration("agentLens");
      const report = await collectDiagnostics(
        {
          remoteName: vscode.env.remoteName ?? null,
          workspacePath: sessionCtx.workspacePath,
          storageUri: context.storageUri?.fsPath ?? null,
          homeDir: os.homedir(),
          platform: process.platform,
          codexHome: process.env.CODEX_HOME ?? null,
        },
        {
          sessionDir: config.get<string>("sessionDir") || null,
          claudeDir: config.get<string>("claudeDir") || null,
          codexDir: config.get<string>("codexDir") || null,
        },
      );
      for (const line of formatDiagnosticReport(report).split("\n")) {
        outputChannel.info(line);
      }
      outputChannel.show();
    },
  );

  // File watchers — auto-refresh on agent/skill/session changes
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(sessionCtx, treeProvider), 2000);
  }

  const agentWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.github/agents/*.agent.md",
  );
  const claudeAgentWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.claude/agents/*.md",
  );
  const skillWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.github/skills/*/SKILL.md",
  );
  const skillFlatWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.github/skills/*.skill.md",
  );
  const claudeSkillWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.claude/skills/*/SKILL.md",
  );

  agentWatcher.onDidCreate(scheduleRefresh);
  agentWatcher.onDidChange(scheduleRefresh);
  agentWatcher.onDidDelete(scheduleRefresh);
  claudeAgentWatcher.onDidCreate(scheduleRefresh);
  claudeAgentWatcher.onDidChange(scheduleRefresh);
  claudeAgentWatcher.onDidDelete(scheduleRefresh);
  skillWatcher.onDidCreate(scheduleRefresh);
  skillWatcher.onDidChange(scheduleRefresh);
  skillWatcher.onDidDelete(scheduleRefresh);
  skillFlatWatcher.onDidCreate(scheduleRefresh);
  skillFlatWatcher.onDidChange(scheduleRefresh);
  skillFlatWatcher.onDidDelete(scheduleRefresh);
  claudeSkillWatcher.onDidCreate(scheduleRefresh);
  claudeSkillWatcher.onDidChange(scheduleRefresh);
  claudeSkillWatcher.onDidDelete(scheduleRefresh);

  context.subscriptions.push(
    outputChannel,
    treeView,
    refreshCmd,
    showGraph,
    openMetrics,
    openSession,
    openContainerSetup,
    diagnoseCmd,
    agentWatcher,
    claudeAgentWatcher,
    skillWatcher,
    skillFlatWatcher,
    claudeSkillWatcher,
  );

  // Watch session files from all providers
  for (const target of collectWatchTargets(sessionCtx)) {
    const watcher = vscode.workspace.createFileSystemWatcher(target.pattern);
    if (target.events.includes("create")) watcher.onDidCreate(scheduleRefresh);
    if (target.events.includes("change")) watcher.onDidChange(scheduleRefresh);
    if (target.events.includes("delete")) watcher.onDidDelete(scheduleRefresh);
    context.subscriptions.push(watcher);
  }

  // Initial scan
  void refresh(sessionCtx, treeProvider);
}

export function deactivate(): void {
  // cleanup
}
