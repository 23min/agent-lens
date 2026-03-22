import * as vscode from "vscode";
import type { Session, SessionProviderType } from "../models/session.js";

type SourceFilter = SessionProviderType | "all";

export class SessionPanel {
  private static instance: SessionPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private currentFilter: SourceFilter = "all";
  private currentScope: "all-projects" | "current-project" = "all-projects";
  private cachedSessions: Session[] = [];
  private customAgentNames: string[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.panel = panel;

    this.panel.onDidDispose(() => {
      this.disposed = true;
      SessionPanel.instance = undefined;
    });

    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "ready") {
        this.pushFilteredSessions();
      }
      if (msg.type === "filter-change") {
        this.currentFilter = msg.provider;
        this.pushFilteredSessions();
      }
      if (msg.type === "scope-change") {
        this.currentScope = msg.scope;
        this.pushFilteredSessions();
      }
    });
  }

  static show(
    extensionUri: vscode.Uri,
    sessions: Session[],
    customAgentNames: string[] = [],
  ): SessionPanel {
    if (SessionPanel.instance && !SessionPanel.instance.disposed) {
      SessionPanel.instance.panel.reveal();
      SessionPanel.instance.updateSessions(sessions, customAgentNames);
      return SessionPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      "agentLens.session",
      "Agent Lens: Session Explorer",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "out", "webview"),
        ],
        retainContextWhenHidden: true,
      },
    );

    const instance = new SessionPanel(panel, extensionUri);
    SessionPanel.instance = instance;

    panel.webview.html = instance.getHtml(panel.webview);
    instance.updateSessions(sessions, customAgentNames);

    return instance;
  }

  updateSessions(sessions: Session[], customAgentNames?: string[]): void {
    if (this.disposed) return;
    this.cachedSessions = sessions;
    if (customAgentNames) this.customAgentNames = customAgentNames;
    this.pushFilteredSessions();
  }

  private pushFilteredSessions(): void {
    let filtered =
      this.currentFilter === "all"
        ? this.cachedSessions
        : this.cachedSessions.filter(
            (s) => s.provider === this.currentFilter,
          );
    if (this.currentScope === "current-project") {
      filtered = filtered.filter((s) => s.isCurrentWorkspace === true);
    }
    const nonEmpty = filtered.filter((s) => s.requests.length > 0);
    const emptyCount = filtered.length - nonEmpty.length;
    this.panel.webview.postMessage({
      type: "update-sessions",
      sessions: nonEmpty,
      activeFilter: this.currentFilter,
      emptyCount,
      customAgentNames: this.customAgentNames,
    });
  }

  static updateIfOpen(sessions: Session[], customAgentNames?: string[]): void {
    if (SessionPanel.instance && !SessionPanel.instance.disposed) {
      SessionPanel.instance.updateSessions(sessions, customAgentNames);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "session.js"),
    );

    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <title>Agent Lens: Session Explorer</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }
  </style>
</head>
<body>
  <session-explorer></session-explorer>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
