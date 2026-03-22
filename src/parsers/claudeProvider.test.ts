import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(null) }),
  },
  RelativePattern: vi.fn((base: { fsPath: string }, pattern: string) => ({ base, pattern })),
  Uri: { file: vi.fn((p: string) => ({ fsPath: p })) },
}));

vi.mock("./claudeLocator.js", () => ({
  discoverClaudeSessions: vi.fn(),
  discoverClaudeSessionsInDir: vi.fn(),
  discoverAllClaudeProjects: vi.fn(),
  encodeProjectPath: vi.fn((p: string) => p.replace(/\//g, "-")),
}));

vi.mock("./claudeSessionParser.js", () => ({
  parseClaudeSessionJsonl: vi.fn(),
  buildSubagentTypeMap: vi.fn().mockReturnValue(new Map()),
}));

vi.mock("../logger.js", () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { ClaudeSessionProvider } from "./claudeProvider.js";
import type { SessionDiscoveryContext } from "./sessionProvider.js";
import * as vscode from "vscode";
import * as locator from "./claudeLocator.js";
import * as sessionParser from "./claudeSessionParser.js";

const mockStat = vi.mocked(fs.stat);
const mockReadFile = vi.mocked(fs.readFile);
const mockDiscoverAll = vi.mocked(locator.discoverAllClaudeProjects);
const mockParseSession = vi.mocked(sessionParser.parseClaudeSessionJsonl);

const MAIN_PATH = "/home/user/.claude/projects/-work-project/session-abc.jsonl";
const SUB_PATH = "/home/user/.claude/projects/-work-project/session-abc/subagents/agent-sub1.jsonl";

function makeCtx(): SessionDiscoveryContext {
  return { workspacePath: "/work/project", extensionContext: {} as any };
}

function makeEntry(subagentPaths: string[] = []) {
  return {
    sessionId: "session-abc",
    fullPath: MAIN_PATH,
    summary: null,
    messageCount: 0,
    created: "",
    modified: "",
    gitBranch: "",
    subagentPaths,
    projectName: "my-project",
    isCurrentWorkspace: true,
  };
}

function makeSession(id = "session-abc") {
  return {
    sessionId: id,
    provider: "Claude" as const,
    requests: [],
  } as any;
}

beforeEach(() => {
  vi.resetAllMocks();

  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultVal?: unknown) => {
      if (key === "discoverAllProjects") return true;
      return defaultVal ?? null;
    }),
  } as any);

  mockDiscoverAll.mockResolvedValue([makeEntry()]);
  mockParseSession.mockResolvedValue(makeSession());
  mockReadFile.mockResolvedValue("jsonl-content" as any);
  let mtimeCounter = 0;
  mockStat.mockImplementation(async () => ({ mtimeMs: ++mtimeCounter }) as any);
});

// ---------------------------------------------------------------------------
// Fix 2: Subagent cache staleness
// ---------------------------------------------------------------------------

describe("ClaudeSessionProvider — subagent cache staleness (Fix 2)", () => {
  it("uses cache on second call when main file and subagent are both unchanged", async () => {
    mockDiscoverAll.mockResolvedValue([makeEntry([SUB_PATH])]);

    // Stable mtimes for both files
    mockStat.mockImplementation(async (p) => {
      const ps = String(p);
      if (ps === MAIN_PATH) return { mtimeMs: 1000 } as any;
      if (ps === SUB_PATH) return { mtimeMs: 2000 } as any;
      return { mtimeMs: 9999 } as any;
    });

    const provider = new ClaudeSessionProvider();

    await provider.discoverSessions(makeCtx());
    const readAfterFirst = vi.mocked(fs.readFile).mock.calls.length;

    await provider.discoverSessions(makeCtx());
    const readAfterSecond = vi.mocked(fs.readFile).mock.calls.length;

    // No additional readFile calls on the second pass (cache hit)
    expect(readAfterSecond).toBe(readAfterFirst);
  });

  it("re-parses when subagent mtime changes even if main file mtime is stable", async () => {
    mockDiscoverAll.mockResolvedValue([makeEntry([SUB_PATH])]);

    let subMtime = 2000;
    mockStat.mockImplementation(async (p) => {
      const ps = String(p);
      if (ps === MAIN_PATH) return { mtimeMs: 1000 } as any;
      if (ps === SUB_PATH) return { mtimeMs: subMtime } as any;
      return { mtimeMs: 9999 } as any;
    });

    const provider = new ClaudeSessionProvider();

    // First call — cache miss, parse happens
    await provider.discoverSessions(makeCtx());
    expect(mockParseSession).toHaveBeenCalledTimes(1);

    // Simulate subagent file change
    subMtime = 3000;

    // Second call — subagent mtime changed, must re-parse
    await provider.discoverSessions(makeCtx());
    expect(mockParseSession).toHaveBeenCalledTimes(2);
  });

  it("re-parses when subagent path set grows (new subagent added)", async () => {
    const SUB_PATH_2 = "/home/user/.claude/projects/-work-project/session-abc/subagents/agent-sub2.jsonl";

    // First call: one subagent
    mockDiscoverAll.mockResolvedValueOnce([makeEntry([SUB_PATH])]);
    // Second call: two subagents
    mockDiscoverAll.mockResolvedValueOnce([makeEntry([SUB_PATH, SUB_PATH_2])]);

    mockStat.mockImplementation(async (p) => {
      const ps = String(p);
      if (ps === MAIN_PATH) return { mtimeMs: 1000 } as any;
      return { mtimeMs: 2000 } as any;
    });

    const provider = new ClaudeSessionProvider();

    await provider.discoverSessions(makeCtx());
    expect(mockParseSession).toHaveBeenCalledTimes(1);

    await provider.discoverSessions(makeCtx());
    // New subagent added → set size differs → must re-parse
    expect(mockParseSession).toHaveBeenCalledTimes(2);
  });

  it("re-parses when subagent path set shrinks (subagent removed)", async () => {
    const SUB_PATH_2 = "/home/user/.claude/projects/-work-project/session-abc/subagents/agent-sub2.jsonl";

    // First call: two subagents
    mockDiscoverAll.mockResolvedValueOnce([makeEntry([SUB_PATH, SUB_PATH_2])]);
    // Second call: one subagent (removed)
    mockDiscoverAll.mockResolvedValueOnce([makeEntry([SUB_PATH])]);

    mockStat.mockImplementation(async (p) => {
      const ps = String(p);
      if (ps === MAIN_PATH) return { mtimeMs: 1000 } as any;
      return { mtimeMs: 2000 } as any;
    });

    const provider = new ClaudeSessionProvider();

    await provider.discoverSessions(makeCtx());
    expect(mockParseSession).toHaveBeenCalledTimes(1);

    await provider.discoverSessions(makeCtx());
    // Subagent removed → set size differs → must re-parse
    expect(mockParseSession).toHaveBeenCalledTimes(2);
  });

  it("re-parses when a subagent stat throws (file disappeared mid-check)", async () => {
    mockDiscoverAll.mockResolvedValue([makeEntry([SUB_PATH])]);

    let callCount = 0;
    mockStat.mockImplementation(async (p) => {
      const ps = String(p);
      if (ps === MAIN_PATH) return { mtimeMs: 1000 } as any;
      if (ps === SUB_PATH) {
        callCount++;
        // On the second discovery the stat for the subagent throws
        if (callCount > 1) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { mtimeMs: 2000 } as any;
      }
      return { mtimeMs: 9999 } as any;
    });

    const provider = new ClaudeSessionProvider();

    await provider.discoverSessions(makeCtx());
    expect(mockParseSession).toHaveBeenCalledTimes(1);

    await provider.discoverSessions(makeCtx());
    // Subagent stat threw → treat as changed → re-parse
    expect(mockParseSession).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: claudeDir watch target in global mode
// ---------------------------------------------------------------------------

describe("ClaudeSessionProvider — getWatchTargets in global mode (Fix 3)", () => {
  it("includes ~/.claude/projects watcher in global mode", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultVal?: unknown) => {
        if (key === "discoverAllProjects") return true;
        return defaultVal ?? null;
      }),
    } as any);

    const provider = new ClaudeSessionProvider();
    const targets = provider.getWatchTargets(makeCtx());

    const patterns = targets.map((t) => (t.pattern as any).pattern ?? t.pattern);
    expect(patterns.some((p) => p === "**/*.jsonl")).toBe(true);
  });

  it("includes configured claudeDir watcher in global mode when claudeDir is set", () => {
    const configDir = "/mnt/custom-claude-dir";

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultVal?: unknown) => {
        if (key === "discoverAllProjects") return true;
        if (key === "claudeDir") return configDir;
        return defaultVal ?? null;
      }),
    } as any);

    const provider = new ClaudeSessionProvider();
    const targets = provider.getWatchTargets(makeCtx());

    const bases = targets.map((t) => (t.pattern as any).base?.fsPath ?? "");
    expect(bases).toContain(configDir);
  });

  it("does not add a claudeDir watcher in global mode when claudeDir is not set", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultVal?: unknown) => {
        if (key === "discoverAllProjects") return true;
        // claudeDir not configured
        return defaultVal ?? null;
      }),
    } as any);

    const provider = new ClaudeSessionProvider();
    const targets = provider.getWatchTargets(makeCtx());

    // Only the ~/.claude/projects watcher, no extra entry for a configDir
    expect(targets).toHaveLength(1);
  });

  it("adds exactly two watchers in global mode when claudeDir is set", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultVal?: unknown) => {
        if (key === "discoverAllProjects") return true;
        if (key === "claudeDir") return "/mnt/custom";
        return defaultVal ?? null;
      }),
    } as any);

    const provider = new ClaudeSessionProvider();
    const targets = provider.getWatchTargets(makeCtx());

    expect(targets).toHaveLength(2);
    expect(targets.every((t) => t.events)).toBeTruthy();
  });
});
