import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getLogger } from "../logger.js";

/** Yield control to the event loop to prevent extension host unresponsiveness */
function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export interface ClaudeSessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string | null;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  subagentPaths: string[];
  projectName?: string;
  isCurrentWorkspace?: boolean;
}

/**
 * Encode a workspace path the way Claude Code does:
 * `/Users/peterbru/project` → `-Users-peterbru-project`
 */
export function encodeProjectPath(workspacePath: string): string {
  return workspacePath.replace(/[/\\]+$/, "").replace(/:/g, "-").replace(/[/\\]/g, "-");
}

/**
 * Return encoded-path variants to try. In containers, VS Code may report
 * workspace paths with underscores where the actual filesystem has dashes
 * (or vice versa), so we try both forms.
 */
export function encodedPathVariants(workspacePath: string): string[] {
  const primary = encodeProjectPath(workspacePath);
  const alt = primary.includes("_")
    ? primary.replace(/_/g, "-")
    : primary.includes("-")
      ? null // don't try replacing all dashes — too many false positives
      : null;
  return alt && alt !== primary ? [primary, alt] : [primary];
}

/**
 * Parse a Claude Code sessions-index.json file.
 * Returns an empty array on any error.
 */
export function parseSessionIndex(raw: string): ClaudeSessionEntry[] {
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.entries)) return [];
    return data.entries.map(
      (e: Record<string, unknown>): ClaudeSessionEntry => ({
        sessionId: String(e.sessionId ?? ""),
        fullPath: String(e.fullPath ?? ""),
        summary: e.summary ? String(e.summary) : null,
        messageCount: Number(e.messageCount ?? 0),
        created: String(e.created ?? ""),
        modified: String(e.modified ?? ""),
        gitBranch: String(e.gitBranch ?? ""),
        subagentPaths: [],
      }),
    );
  } catch {
    return [];
  }
}

/**
 * Discover Claude Code session files for a given workspace path.
 * Returns the list of JSONL file paths and their index metadata.
 */
export async function discoverClaudeSessions(
  workspacePath: string,
): Promise<ClaudeSessionEntry[]> {
  const log = getLogger();
  const claudeRoot = path.join(os.homedir(), ".claude", "projects");
  const variants = encodedPathVariants(workspacePath);

  log.debug(`Claude session discovery: trying ${variants.length} variant(s) in ${claudeRoot}`);

  // Try each encoded-path variant
  let projectDir: string | null = null;
  for (const encoded of variants) {
    const candidate = path.join(claudeRoot, encoded);
    try {
      await fs.access(candidate);
      log.debug(`  Matched project dir: "${encoded}"`);
      projectDir = candidate;
      break;
    } catch {
      log.debug(`  No match for "${encoded}"`);
    }
  }

  if (!projectDir) {
    log.debug("  No Claude project directory found");
    return [];
  }

  // Read sessions-index.json
  const indexPath = path.join(projectDir, "sessions-index.json");
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const entries = parseSessionIndex(raw);
    log.debug(`  Found ${entries.length} session(s) in index`);

    // Verify each session file exists and discover subagent files
    const verified: ClaudeSessionEntry[] = [];
    for (const entry of entries) {
      try {
        await fs.access(entry.fullPath);
        entry.subagentPaths = await discoverSubagentFiles(
          projectDir,
          entry.sessionId,
        );
        verified.push(entry);
      } catch {
        log.warn(`  Session file missing: ${entry.fullPath}`);
      }
    }

    log.debug(`  Verified ${verified.length} session file(s)`);
    return verified;
  } catch {
    log.debug("  No sessions-index.json found, scanning directory");
  }

  // Fallback: scan for JSONL files directly
  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    log.debug(`  Found ${jsonlFiles.length} JSONL file(s) by scan`);

    const fallbackEntries: ClaudeSessionEntry[] = [];
    for (const f of jsonlFiles) {
      const sessionId = f.replace(/\.jsonl$/, "");
      fallbackEntries.push({
        sessionId,
        fullPath: path.join(projectDir, f),
        summary: null,
        messageCount: 0,
        created: "",
        modified: "",
        gitBranch: "",
        subagentPaths: await discoverSubagentFiles(projectDir, sessionId),
      });
    }
    return fallbackEntries;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`  Cannot read Claude project dir: ${msg}`);
    return [];
  }
}

/**
 * Discover Claude sessions in a user-configured directory.
 * The dir can be either:
 * - A `projects/` root (contains encoded-path subdirs) — we look for the workspace's subdir
 * - A specific project directory (contains JSONL files directly) — we scan it
 *
 * In container/SSH environments the workspace path differs from the host
 * (e.g. /workspaces/foo vs /Users/.../foo), so exact encoded-path matching
 * may fail. When it does, we scan all subdirectories as a fallback.
 */
export async function discoverClaudeSessionsInDir(
  configDir: string,
  workspacePath: string | null,
): Promise<ClaudeSessionEntry[]> {
  const log = getLogger();

  try {
    await fs.access(configDir);
  } catch {
    log.debug(`  Configured claudeDir not accessible: "${configDir}"`);
    return [];
  }

  // Strategy A: if workspacePath is set, try encoded-path match (with variants)
  if (workspacePath) {
    const variants = encodedPathVariants(workspacePath);
    for (const encoded of variants) {
      const projectSubDir = path.join(configDir, encoded);
      try {
        await fs.access(projectSubDir);
        log.debug(`  Found project subdir: "${encoded}"`);
        return await scanProjectDir(projectSubDir);
      } catch {
        log.debug(`  No match for "${encoded}"`);
      }
    }
  }

  // Strategy B: treat configDir as a direct project directory (has JSONL files)
  const direct = await scanProjectDir(configDir);
  if (direct.length > 0) return direct;

  // Strategy C: match by workspace folder name (handles container path mismatch)
  if (workspacePath) {
    const folderName = path.basename(workspacePath);
    return await scanSubdirsByFolderName(configDir, folderName);
  }

  return [];
}

/**
 * Scan subdirectories in a projects/ root, filtering to those whose encoded
 * path ends with the workspace folder name. Handles container/SSH environments
 * where the full path differs from the host but the folder name matches.
 * E.g. container path `/workspaces/my-app` matches host dir `-Users-foo-my-app`.
 */
async function scanSubdirsByFolderName(
  projectsRoot: string,
  folderName: string,
): Promise<ClaudeSessionEntry[]> {
  const log = getLogger();
  let entries: string[];
  try {
    entries = await fs.readdir(projectsRoot);
  } catch {
    return [];
  }

  const suffixes = [`-${folderName}`];
  if (folderName.includes("_")) {
    suffixes.push(`-${folderName.replace(/_/g, "-")}`);
  }
  const matching = entries.filter(
    (e) => e.startsWith("-") && suffixes.some((s) => e.endsWith(s)),
  );

  if (matching.length === 0) {
    log.debug(`  No project subdirs ending with ${suffixes.map((s) => `"${s}"`).join(" or ")}`);
    return [];
  }

  log.debug(`  Found ${matching.length} subdir(s) matching folder name "${folderName}"`);
  const allSessions: ClaudeSessionEntry[] = [];
  for (const entry of matching) {
    const subDir = path.join(projectsRoot, entry);
    try {
      const stat = await fs.stat(subDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const sessions = await scanProjectDir(subDir);
    allSessions.push(...sessions);
  }

  log.debug(`  Found ${allSessions.length} session(s) via folder name match`);
  return allSessions;
}

export async function scanProjectDir(
  projectDir: string,
): Promise<ClaudeSessionEntry[]> {
  const log = getLogger();

  // Try sessions-index.json first
  const indexPath = path.join(projectDir, "sessions-index.json");
  const indexedIds = new Set<string>();
  const verified: ClaudeSessionEntry[] = [];
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const entries = parseSessionIndex(raw);
    if (entries.length > 0) {
      log.debug(`  Found ${entries.length} session(s) in index at ${projectDir}`);
      for (const entry of entries) {
        try {
          await fs.access(entry.fullPath);
          entry.subagentPaths = await discoverSubagentFiles(
            projectDir,
            entry.sessionId,
          );
          indexedIds.add(entry.sessionId);
          verified.push(entry);
        } catch {
          log.warn(`  Session file missing: ${entry.fullPath}`);
        }
      }
    }
  } catch {
    // No index, fall through to scan
  }

  // Always scan for JSONL files not covered by the index
  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    log.debug(`  Found ${jsonlFiles.length} JSONL file(s) by scan in ${projectDir}`);
    for (const f of jsonlFiles) {
      const sessionId = f.replace(/\.jsonl$/, "");
      if (indexedIds.has(sessionId)) continue;
      verified.push({
        sessionId,
        fullPath: path.join(projectDir, f),
        summary: null,
        messageCount: 0,
        created: "",
        modified: "",
        gitBranch: "",
        subagentPaths: await discoverSubagentFiles(projectDir, sessionId),
      });
    }
  } catch {
    // ignore scan errors
  }

  return verified;
}

/**
 * Extract a human-readable project name from an encoded Claude project directory name.
 *
 * Claude encodes workspace paths by replacing `:`, `/`, and `\` with `-`.
 * For example `C:\Users\info\Documents\git\agent-lens` becomes
 * `C--Users-info-Documents-git-agent-lens`.
 *
 * Since project names can themselves contain dashes we use known parent directory
 * markers to locate the boundary between the parent path and the project name.
 * If no known marker is found the full encoded dir is returned unchanged.
 */
export function decodeProjectName(encodedDir: string): string {
  const markers = [
    "-git-",
    "-src-",
    "-repos-",
    "-repo-",
    "-code-",
    "-projects-",
    "-Projects-",
    "-Documents-",
    "-workspaces-",
    "-workspace-",
    "-repositories-",
    "-dev-",
    "-work-",
    "-home-",
  ];
  let bestIdx = -1;
  let bestLen = 0;
  for (const m of markers) {
    const idx = encodedDir.lastIndexOf(m);
    if (idx > bestIdx) {
      bestIdx = idx;
      bestLen = m.length;
    }
  }
  if (bestIdx >= 0) {
    return encodedDir.slice(bestIdx + bestLen);
  }
  return encodedDir;
}

/**
 * Discover Claude Code sessions across ALL projects in `~/.claude/projects/`.
 *
 * Each returned entry is annotated with:
 * - `projectName` — a human-readable name derived from the encoded directory name
 * - `isCurrentWorkspace` — true when the encoded directory matches the current workspace path
 */
export async function discoverAllClaudeProjects(
  currentWorkspacePath: string | null,
): Promise<ClaudeSessionEntry[]> {
  const log = getLogger();
  const claudeRoot = path.join(os.homedir(), ".claude", "projects");

  let subdirs: string[];
  try {
    subdirs = await fs.readdir(claudeRoot);
  } catch {
    log.debug("Claude global discovery: cannot read projects root");
    return [];
  }

  const currentVariants = currentWorkspacePath
    ? new Set(encodedPathVariants(currentWorkspacePath))
    : new Set<string>();

  const allEntries: ClaudeSessionEntry[] = [];
  let dirIndex = 0;
  for (const subdir of subdirs) {
    // Yield every 10 project directories to prevent blocking the event loop
    if (dirIndex > 0 && dirIndex % 10 === 0) {
      await yieldEventLoop();
    }
    dirIndex++;
    const fullPath = path.join(claudeRoot, subdir);
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const entries = await scanProjectDir(fullPath);
    const projectName = decodeProjectName(subdir);
    for (const entry of entries) {
      entry.projectName = projectName;
      entry.isCurrentWorkspace = currentVariants.has(subdir);
      allEntries.push(entry);
    }
  }

  return allEntries;
}

async function discoverSubagentFiles(
  projectDir: string,
  sessionId: string,
): Promise<string[]> {
  const subagentDir = path.join(projectDir, sessionId, "subagents");
  try {
    const files = await fs.readdir(subagentDir);
    return files
      .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"))
      .map((f) => path.join(subagentDir, f));
  } catch {
    return [];
  }
}
