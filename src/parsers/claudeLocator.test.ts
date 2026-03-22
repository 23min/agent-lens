import { describe, it, expect } from "vitest";
import { encodeProjectPath, encodedPathVariants, parseSessionIndex, decodeProjectName } from "./claudeLocator.js";

describe("encodeProjectPath", () => {
  it("replaces slashes with dashes", () => {
    expect(encodeProjectPath("/Users/peterbru/Dropbox/Projects/my-app")).toBe(
      "-Users-peterbru-Dropbox-Projects-my-app",
    );
  });

  it("handles simple path", () => {
    expect(encodeProjectPath("/home")).toBe("-home");
  });

  it("strips trailing slash", () => {
    expect(encodeProjectPath("/Users/peterbru/project/")).toBe(
      "-Users-peterbru-project",
    );
  });

  it("handles Windows backslash paths", () => {
    expect(encodeProjectPath("C:\\Users\\info\\project")).toBe(
      "C--Users-info-project",
    );
  });

  it("handles Windows drive letter colons", () => {
    expect(encodeProjectPath("C:\\Users\\foo")).toBe("C--Users-foo");
  });

  it("strips trailing backslash", () => {
    expect(encodeProjectPath("C:\\Users\\foo\\")).toBe("C--Users-foo");
  });
});

describe("encodedPathVariants", () => {
  it("returns single variant when no underscores", () => {
    expect(encodedPathVariants("/workspaces/my-app")).toEqual([
      "-workspaces-my-app",
    ]);
  });

  it("returns two variants when path contains underscores", () => {
    expect(encodedPathVariants("/workspaces/ex_a2ui")).toEqual([
      "-workspaces-ex_a2ui",
      "-workspaces-ex-a2ui",
    ]);
  });

  it("returns single variant when underscore replacement produces same result", () => {
    // No underscores → no alt variant
    expect(encodedPathVariants("/home/user/project")).toEqual([
      "-home-user-project",
    ]);
  });
});

describe("parseSessionIndex", () => {
  it("parses valid index with entries", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId: "abc-123",
          fullPath: "/home/.claude/projects/-foo/abc-123.jsonl",
          fileMtime: 1700000000000,
          firstPrompt: "hello",
          summary: "Test session",
          messageCount: 10,
          created: "2026-02-10T10:00:00Z",
          modified: "2026-02-10T11:00:00Z",
          gitBranch: "main",
          projectPath: "/foo",
        },
        {
          sessionId: "def-456",
          fullPath: "/home/.claude/projects/-foo/def-456.jsonl",
          fileMtime: 1700000001000,
          firstPrompt: "another",
          summary: "Another session",
          messageCount: 5,
          created: "2026-02-11T10:00:00Z",
          modified: "2026-02-11T11:00:00Z",
          gitBranch: "feature/x",
          projectPath: "/foo",
        },
      ],
    });

    const entries = parseSessionIndex(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].sessionId).toBe("abc-123");
    expect(entries[0].fullPath).toBe(
      "/home/.claude/projects/-foo/abc-123.jsonl",
    );
    expect(entries[0].summary).toBe("Test session");
    expect(entries[1].sessionId).toBe("def-456");
  });

  it("returns empty array for empty entries", () => {
    const raw = JSON.stringify({ version: 1, entries: [] });
    expect(parseSessionIndex(raw)).toEqual([]);
  });

  it("returns empty array for malformed JSON", () => {
    expect(parseSessionIndex("not json")).toEqual([]);
  });

  it("returns empty array for missing entries field", () => {
    expect(parseSessionIndex(JSON.stringify({ version: 1 }))).toEqual([]);
  });

  it("initializes subagentPaths as empty array", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId: "abc-123",
          fullPath: "/home/.claude/projects/-foo/abc-123.jsonl",
          summary: "Test",
          messageCount: 2,
          created: "2026-02-10T10:00:00Z",
          modified: "2026-02-10T11:00:00Z",
          gitBranch: "main",
        },
      ],
    });

    const entries = parseSessionIndex(raw);
    expect(entries[0].subagentPaths).toEqual([]);
  });
});

describe("decodeProjectName", () => {
  it("extracts project name after -git-", () => {
    expect(decodeProjectName("C--Users-info-Documents-git-agent-lens")).toBe("agent-lens");
  });

  it("extracts project name after -workspaces-", () => {
    expect(decodeProjectName("-workspaces-foo")).toBe("foo");
  });

  it("handles project with dashes after known parent", () => {
    expect(decodeProjectName("C--Users-info-Documents-git-pi-zero-hw-management")).toBe(
      "pi-zero-hw-management",
    );
  });

  it("extracts after -src-", () => {
    expect(decodeProjectName("-home-user-src-my-project")).toBe("my-project");
  });

  it("extracts after -Documents-", () => {
    expect(decodeProjectName("-Users-foo-Documents-cool-app")).toBe("cool-app");
  });

  it("returns full encoded dir when no known parent found", () => {
    expect(decodeProjectName("-some-unusual-path-project")).toBe("-some-unusual-path-project");
  });
});
