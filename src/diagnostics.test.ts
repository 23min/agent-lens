import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DiagnosticEnvironment, DiagnosticSettings } from "./diagnostics.js";

// Mock fs before importing the module under test
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

import * as fs from "node:fs/promises";
import { collectDiagnostics, formatDiagnosticReport } from "./diagnostics.js";

const mockAccess = vi.mocked(fs.access);
const mockReaddir = vi.mocked(fs.readdir);
const mockReadFile = vi.mocked(fs.readFile);

function baseEnv(overrides: Partial<DiagnosticEnvironment> = {}): DiagnosticEnvironment {
  return {
    remoteName: null,
    workspacePath: "/home/user/my-project",
    storageUri: "/home/user/.vscode-server/data/User/workspaceStorage/abc123/agent-lens",
    homeDir: "/home/user",
    platform: "linux",
    codexHome: null,
    ...overrides,
  };
}

function noSettings(overrides: Partial<DiagnosticSettings> = {}): DiagnosticSettings {
  return {
    sessionDir: null,
    claudeDir: null,
    codexDir: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default: all fs operations fail (paths not accessible)
  mockAccess.mockRejectedValue(new Error("ENOENT"));
  mockReaddir.mockRejectedValue(new Error("ENOENT"));
  mockReadFile.mockRejectedValue(new Error("ENOENT"));
});

describe("collectDiagnostics", () => {
  it("populates environment info correctly", async () => {
    const env = baseEnv({ remoteName: "dev-container", codexHome: "/custom/codex" });
    const report = await collectDiagnostics(env, noSettings());

    expect(report.environment.remoteName).toBe("dev-container");
    expect(report.environment.workspacePath).toBe("/home/user/my-project");
    expect(report.environment.platform).toBe("linux");
    expect(report.environment.codexHome).toBe("/custom/codex");
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns all three providers", async () => {
    const report = await collectDiagnostics(baseEnv(), noSettings());
    expect(report.providers).toHaveLength(3);
    expect(report.providers.map((p) => p.name)).toEqual(["Copilot", "Claude", "Codex"]);
  });

  describe("Copilot diagnostics", () => {
    it("reports configDir when set and accessible", async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(["s1.jsonl", "s2.jsonl", "readme.txt"] as unknown as never);
      mockReadFile.mockResolvedValue('{"requests":[{}]}');

      const report = await collectDiagnostics(
        baseEnv(),
        noSettings({ sessionDir: "/mnt/host-sessions" }),
      );
      const copilot = report.providers[0];

      expect(copilot.configuredDir).toBe("/mnt/host-sessions");
      const configStrategy = copilot.strategies.find((s) => s.name === "configDir");
      expect(configStrategy?.accessible).toBe(true);
      expect(configStrategy?.details).toContain("2 session file(s)");
    });

    it("reports primary hash dir when no configDir", async () => {
      const report = await collectDiagnostics(baseEnv(), noSettings());
      const copilot = report.providers[0];

      expect(copilot.strategies.find((s) => s.name === "configDir")).toBeUndefined();
      const primary = copilot.strategies.find((s) => s.name === "primaryHash");
      expect(primary).toBeDefined();
      expect(primary?.path).toContain("chatSessions");
    });

    it("skips primary hash and sibling scan when no storageUri", async () => {
      const report = await collectDiagnostics(
        baseEnv({ storageUri: null }),
        noSettings(),
      );
      const copilot = report.providers[0];

      const primary = copilot.strategies.find((s) => s.name === "primaryHash");
      expect(primary?.accessible).toBe(false);
      expect(primary?.details).toContain("storageUri");
      expect(copilot.strategies.find((s) => s.name === "siblingScan")).toBeUndefined();
    });
  });

  describe("Claude diagnostics", () => {
    it("reports default path with sessions-index.json", async () => {
      const projectDir = "/home/user/.claude/projects/-home-user-my-project";
      const indexPath = projectDir + "/sessions-index.json";

      mockAccess.mockImplementation(async (p) => {
        const ps = String(p).replace(/\\/g, "/");
        if (ps === projectDir || ps === indexPath) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockImplementation(async (p) => {
        const ps = String(p).replace(/\\/g, "/");
        if (ps === indexPath) {
          return JSON.stringify({
            entries: [
              { sessionId: "a", fullPath: "/a.jsonl" },
              { sessionId: "b", fullPath: "/b.jsonl" },
              { sessionId: "c", fullPath: "/c.jsonl" },
            ],
          });
        }
        throw new Error("ENOENT");
      });

      const report = await collectDiagnostics(baseEnv(), noSettings());
      const claude = report.providers[1];

      const defaultPath = claude.strategies.find((s) => s.name === "defaultPath");
      expect(defaultPath?.accessible).toBe(true);
      expect(defaultPath?.details).toContain("3");
      expect(defaultPath?.details).toContain("sessions-index.json");
      expect(claude.totalFiles).toBe(3);
    });

    it("reports configDir when set", async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(["session.jsonl"] as unknown as never);

      const report = await collectDiagnostics(
        baseEnv(),
        noSettings({ claudeDir: "/mnt/claude/projects" }),
      );
      const claude = report.providers[1];

      const configStrategy = claude.strategies.find((s) => s.name === "configDir");
      expect(configStrategy?.accessible).toBe(true);
      expect(claude.configuredDir).toBe("/mnt/claude/projects");
    });

    it("skips default path when no workspace path", async () => {
      const report = await collectDiagnostics(
        baseEnv({ workspacePath: null }),
        noSettings(),
      );
      const claude = report.providers[1];

      const defaultPath = claude.strategies.find((s) => s.name === "defaultPath");
      expect(defaultPath?.details).toContain("skipped");
    });
  });

  describe("Codex diagnostics", () => {
    it("reports default path with recursive file count", async () => {
      mockAccess.mockImplementation(async (p) => {
        if (String(p).replace(/\\/g, "/").includes(".codex/sessions")) return undefined;
        throw new Error("ENOENT");
      });
      mockReaddir.mockImplementation(async (p) => {
        const dirStr = String(p);
        if (dirStr.endsWith("sessions")) {
          return [
            { name: "openai", isDirectory: () => true },
          ] as unknown as never;
        }
        if (dirStr.endsWith("openai")) {
          return [
            { name: "session1.jsonl", isDirectory: () => false },
            { name: "session2.jsonl", isDirectory: () => false },
          ] as unknown as never;
        }
        throw new Error("ENOENT");
      });

      const report = await collectDiagnostics(baseEnv(), noSettings());
      const codex = report.providers[2];

      const defaultPath = codex.strategies.find((s) => s.name === "defaultPath");
      expect(defaultPath?.accessible).toBe(true);
      expect(defaultPath?.details).toContain("2 .jsonl file(s)");
    });

    it("reports inaccessible when default dir missing", async () => {
      const report = await collectDiagnostics(baseEnv(), noSettings());
      const codex = report.providers[2];

      const defaultPath = codex.strategies.find((s) => s.name === "defaultPath");
      expect(defaultPath?.accessible).toBe(false);
      expect(defaultPath?.details).toContain("not found");
    });

    it("uses CODEX_HOME in details when set", async () => {
      const report = await collectDiagnostics(
        baseEnv({ codexHome: "/custom/codex" }),
        noSettings(),
      );
      const codex = report.providers[2];

      const defaultPath = codex.strategies.find((s) => s.name === "defaultPath");
      expect(defaultPath?.details).toContain("CODEX_HOME");
    });
  });
});

describe("formatDiagnosticReport", () => {
  it("produces readable output with all sections", () => {
    const report = {
      timestamp: "2026-02-16T14:30:00.000Z",
      environment: {
        remoteName: "dev-container",
        workspacePath: "/workspaces/my-project",
        storageUri: "/home/vscode/.vscode-server/abc/agent-lens",
        homeDir: "/home/vscode",
        platform: "linux",
        codexHome: null,
      },
      providers: [
        {
          name: "Copilot",
          configuredDir: null,
          strategies: [
            { name: "primaryHash", path: "/some/chatSessions", accessible: true, details: "3 session file(s)" },
          ],
          totalFiles: 3,
        },
        {
          name: "Claude",
          configuredDir: "/mnt/claude",
          strategies: [
            { name: "configDir", path: "/mnt/claude", accessible: true, details: "5 .jsonl file(s)" },
          ],
          totalFiles: 5,
        },
        {
          name: "Codex",
          configuredDir: null,
          strategies: [
            { name: "defaultPath", path: "/home/vscode/.codex/sessions", accessible: false, details: "directory not found — via ~/.codex/sessions" },
          ],
          totalFiles: 0,
        },
      ],
    };

    const output = formatDiagnosticReport(report);

    expect(output).toContain("=== Agent Lens: Session Discovery Diagnostic ===");
    expect(output).toContain("Remote:         dev-container");
    expect(output).toContain("Platform:       linux");
    expect(output).toContain("--- Copilot ---");
    expect(output).toContain("sessionDir setting: (not set)");
    expect(output).toContain("[primaryHash]");
    expect(output).toContain("Total session files: 3");
    expect(output).toContain("--- Claude ---");
    expect(output).toContain("claudeDir setting: /mnt/claude");
    expect(output).toContain("--- Codex ---");
    expect(output).toContain("Not accessible");
    expect(output).toContain("Agent Lens: Refresh");
  });

  it("shows (local) when remoteName is null", () => {
    const report = {
      timestamp: "2026-02-16T14:30:00.000Z",
      environment: baseEnv({ remoteName: null }),
      providers: [],
    };

    const output = formatDiagnosticReport(report);
    expect(output).toContain("Remote:         (local)");
  });
});
