import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { parseSessionJsonl } from "./sessionParser.js";
import type { Session } from "../models/session.js";
import type {
  SessionProvider,
  SessionDiscoveryContext,
  WatchTarget,
} from "./sessionProvider.js";
import { getLogger } from "../logger.js";
import { getPlatformStorageRoot } from "./platformStorage.js";

/** Yield control to the event loop to prevent extension host unresponsiveness */
function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** Skip session files larger than this to avoid blocking the event loop on huge files */
const MAX_SESSION_FILE_BYTES = 15 * 1024 * 1024; // 15 MB

interface SessionCacheEntry {
  mtimeMs: number;
  session: Session;
}

/**
 * Read all session files from a single chatSessions directory.
 * Optionally uses a cache to skip unchanged files (by mtime).
 */
async function readSessionsFromDir(
  dir: string,
  cache?: Map<string, SessionCacheEntry>,
  seenFiles?: Set<string>,
): Promise<Session[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      getLogger().debug(`  Session dir not found: "${dir}"`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().warn(`  Cannot read session dir "${dir}": ${msg}`);
    }
    return [];
  }

  const sessions: Session[] = [];
  let emptyCount = 0;
  let fileIndex = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl") && !entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    seenFiles?.add(filePath);
    // Yield every 5 files to prevent blocking the event loop
    if (fileIndex > 0 && fileIndex % 5 === 0) {
      await yieldEventLoop();
    }
    fileIndex++;
    try {
      const stats = await fs.stat(filePath);
      if (stats.size > MAX_SESSION_FILE_BYTES) {
        getLogger().debug(`  Skipping oversized session file (${Math.round(stats.size / 1024 / 1024)} MB): "${filePath}"`);
        continue;
      }
      const cached = cache?.get(filePath);
      if (cached && cached.mtimeMs === stats.mtimeMs) {
        sessions.push(cached.session);
        if (cached.session.requests.length === 0) emptyCount++;
        continue;
      }
      const content = await fs.readFile(filePath, "utf-8");
      const session = await parseSessionJsonl(content);
      cache?.set(filePath, { mtimeMs: stats.mtimeMs, session });
      if (session.requests.length === 0) {
        emptyCount++;
      }
      sessions.push(session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().warn(`  Skipping session file "${filePath}": ${msg}`);
    }
  }
  if (emptyCount > 0) {
    getLogger().debug(`  Found ${sessions.length} session(s), ${emptyCount} empty (no requests)`);
  }
  return sessions;
}

/**
 * Extract the workspace folder URI from a workspace.json file.
 */
async function readWorkspaceUri(
  hashDir: string,
): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(hashDir, "workspace.json"),
      "utf-8",
    );
    const data = JSON.parse(raw);
    return data.folder ?? data.workspace ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract the workspace folder name from a URI string.
 */
function workspaceName(uri: string): string {
  const cleaned = uri.replace(/\/+$/, "");
  const lastSlash = cleaned.lastIndexOf("/");
  return lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
}

interface ChatSessionsMatch {
  dir: string;
  workspaceUri: string;
}

/**
 * Scan a workspaceStorage root for chatSessions directories that match
 * the current workspace by folder name. Returns each match with its
 * workspace URI so callers can stamp matchedWorkspace on sessions.
 */
async function scanWorkspaceStorageRoot(
  workspaceStorageRoot: string,
  targetName: string,
): Promise<ChatSessionsMatch[]> {
  const log = getLogger();
  let hashDirs: string[];
  try {
    hashDirs = await fs.readdir(workspaceStorageRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`  Cannot read storage root "${workspaceStorageRoot}": ${msg}`);
    return [];
  }

  log.debug(`  Scanning ${hashDirs.length} hash dir(s) for workspace "${targetName}"`);
  const matches: ChatSessionsMatch[] = [];
  for (const entry of hashDirs) {
    const candidateDir = path.join(workspaceStorageRoot, entry);
    const candidateUri = await readWorkspaceUri(candidateDir);
    if (!candidateUri) continue;

    if (workspaceName(candidateUri) === targetName) {
      matches.push({
        dir: path.join(candidateDir, "chatSessions"),
        workspaceUri: candidateUri,
      });
    }
  }
  return matches;
}

async function collectFromMatches(
  matches: ChatSessionsMatch[],
  scope: "workspace" | "fallback",
  cache?: Map<string, SessionCacheEntry>,
  seenFiles?: Set<string>,
): Promise<Session[]> {
  const seen = new Set<string>();
  const sessions: Session[] = [];
  for (const { dir, workspaceUri } of matches) {
    const found = await readSessionsFromDir(dir, cache, seenFiles);
    for (const s of found) {
      if (!seen.has(s.sessionId)) {
        seen.add(s.sessionId);
        s.scope = scope;
        s.matchedWorkspace = workspaceUri;
        sessions.push(s);
      }
    }
  }
  return sessions;
}

/**
 * Scan ALL hash directories under a workspaceStorage root, returning sessions
 * from every workspace (not filtered). Each session gets projectName and
 * isCurrentWorkspace stamped.
 */
async function scanAllWorkspaceStorageDirs(
  workspaceStorageRoot: string,
  currentWorkspaceName: string | null,
  cache?: Map<string, SessionCacheEntry>,
  seenFiles?: Set<string>,
): Promise<Session[]> {
  const log = getLogger();
  let hashDirs: string[];
  try {
    hashDirs = await fs.readdir(workspaceStorageRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`  Cannot read storage root "${workspaceStorageRoot}": ${msg}`);
    return [];
  }

  log.debug(`  Scanning ${hashDirs.length} hash dir(s) globally`);
  const seen = new Set<string>();
  const sessions: Session[] = [];

  let dirIndex = 0;
  for (const entry of hashDirs) {
    // Yield every 10 directories to prevent blocking the event loop
    if (dirIndex > 0 && dirIndex % 10 === 0) {
      await yieldEventLoop();
    }
    dirIndex++;
    const candidateDir = path.join(workspaceStorageRoot, entry);
    const candidateUri = await readWorkspaceUri(candidateDir);
    if (!candidateUri) continue;

    const chatDir = path.join(candidateDir, "chatSessions");
    const found = await readSessionsFromDir(chatDir, cache, seenFiles);
    const name = workspaceName(candidateUri);
    const isCurrent = currentWorkspaceName !== null && name === currentWorkspaceName;

    for (const s of found) {
      if (seen.has(s.sessionId)) continue;
      seen.add(s.sessionId);
      s.projectName = name;
      s.isCurrentWorkspace = isCurrent;
      s.scope = "workspace";
      s.matchedWorkspace = candidateUri;
      sessions.push(s);
    }
  }

  return sessions;
}

/**
 * Get the current workspace's folder name for matching.
 */
async function getWorkspaceFolderName(
  context: vscode.ExtensionContext,
): Promise<string | null> {
  const storageUri = context.storageUri;
  if (storageUri) {
    const hashDir = path.dirname(storageUri.fsPath);
    const ourUri = await readWorkspaceUri(hashDir);
    if (ourUri) return workspaceName(ourUri);
  }
  return vscode.workspace.workspaceFolders?.[0]?.name ?? null;
}

function getChatSessionsDir(
  context: vscode.ExtensionContext,
): string | null {
  const storageUri = context.storageUri;
  if (!storageUri) return null;
  const workspaceHashDir = path.dirname(storageUri.fsPath);
  return path.join(workspaceHashDir, "chatSessions");
}

/**
 * Return the platform-native VS Code app storage root.
 * Re-exported from platformStorage for backwards compatibility.
 */
export { getPlatformStorageRoot } from "./platformStorage.js";

/**
 * Accumulate sessions into a pool, deduplicating by sessionId.
 */
function mergeInto(
  pool: Session[],
  seen: Set<string>,
  incoming: Session[],
): number {
  let added = 0;
  for (const s of incoming) {
    if (!seen.has(s.sessionId)) {
      seen.add(s.sessionId);
      pool.push(s);
      added++;
    }
  }
  return added;
}

export class CopilotSessionProvider implements SessionProvider {
  readonly name = "Copilot";
  private sessionCache = new Map<string, SessionCacheEntry>();

  /** Overridable for testing. */
  protected getPlatformStorageRoot(): string | null {
    return getPlatformStorageRoot();
  }

  async discoverSessions(ctx: SessionDiscoveryContext): Promise<Session[]> {
    const log = getLogger();
    const { extensionContext } = ctx;
    const ourName = await getWorkspaceFolderName(extensionContext);
    log.debug(`Copilot session discovery: workspace name = "${ourName ?? "(unknown)"}"`);

    const discoverAll = vscode.workspace
      .getConfiguration("agentLens")
      .get<boolean>("discoverAllProjects", true) ?? true;

    if (discoverAll) {
      return this.discoverAllSessions(ctx, ourName);
    }

    const pool: Session[] = [];
    const seen = new Set<string>();
    const seenFiles = new Set<string>();

    // -- Strategy 1: user-configured sessionDir (complements, not overrides) --
    const configDir = vscode.workspace
      .getConfiguration("agentLens")
      .get<string>("sessionDir");

    if (configDir) {
      log.debug(`Copilot strategy 1: user-configured sessionDir = "${configDir}"`);
      const direct = await readSessionsFromDir(configDir, this.sessionCache, seenFiles);
      if (direct.length > 0) {
        log.debug(`  Found ${direct.length} session(s) directly`);
        mergeInto(pool, seen, direct);
      } else if (ourName) {
        const matches = await scanWorkspaceStorageRoot(configDir, ourName);
        const scanned = await collectFromMatches(matches, "workspace", this.sessionCache, seenFiles);
        if (scanned.length > 0) {
          log.debug(`  Found ${scanned.length} session(s) via storage root scan`);
          mergeInto(pool, seen, scanned);
        }
      }
      if (pool.length === 0) {
        log.debug("  No sessions found via configured dir");
      }
    }

    // -- Strategy 2: primary location (current workspace hash) --
    const primaryDir = getChatSessionsDir(extensionContext);
    if (primaryDir) {
      log.debug(`Copilot strategy 2: primary dir = "${primaryDir}"`);
      const primary = await readSessionsFromDir(primaryDir, this.sessionCache, seenFiles);
      if (primary.length > 0) {
        log.debug(`  Found ${primary.length} session(s)`);
        const hashDir = path.dirname(primaryDir);
        const uri = await readWorkspaceUri(hashDir);
        for (const s of primary) {
          s.scope = "workspace";
          if (uri) s.matchedWorkspace = uri;
        }
        mergeInto(pool, seen, primary);
      } else {
        log.debug("  No sessions found in primary dir");
      }
    } else {
      log.debug("Copilot strategy 2: skipped (no storageUri)");
    }

    // -- Strategy 3: sibling hash directories (stale hash recovery) --
    if (ourName && extensionContext.storageUri) {
      const hashDir = path.dirname(extensionContext.storageUri.fsPath);
      const storageRoot = path.dirname(hashDir);
      log.debug(`Copilot strategy 3: scanning sibling dirs under "${storageRoot}"`);
      const matches = await scanWorkspaceStorageRoot(storageRoot, ourName);
      const result = await collectFromMatches(matches, "fallback", this.sessionCache, seenFiles);
      const added = mergeInto(pool, seen, result);
      log.debug(`  Found ${added} new session(s) via sibling scan (stale hash)`);
    }

    // -- Strategy 4: platform app storage root --
    if (ourName) {
      const platformRoot = this.getPlatformStorageRoot();
      // Only probe if it's different from the storage root already scanned in strategy 3
      const currentStorageRoot = extensionContext.storageUri
        ? path.dirname(path.dirname(extensionContext.storageUri.fsPath))
        : null;

      if (platformRoot && platformRoot !== currentStorageRoot) {
        log.debug(`Copilot strategy 4: platform storage root = "${platformRoot}"`);
        const matches = await scanWorkspaceStorageRoot(platformRoot, ourName);
        const result = await collectFromMatches(matches, "workspace", this.sessionCache, seenFiles);
        const added = mergeInto(pool, seen, result);
        log.debug(`  Found ${added} new session(s) via platform storage root`);
      } else if (platformRoot) {
        log.debug("Copilot strategy 4: skipped (same as strategy 3 root)");
      } else {
        log.debug("Copilot strategy 4: skipped (unsupported platform)");
      }
    }

    // Prune stale cache entries for files no longer discovered
    for (const key of this.sessionCache.keys()) {
      if (!seenFiles.has(key)) this.sessionCache.delete(key);
    }

    log.debug(`Copilot: total ${pool.length} session(s) discovered`);
    return pool;
  }

  private async discoverAllSessions(
    ctx: SessionDiscoveryContext,
    currentWorkspaceName: string | null,
  ): Promise<Session[]> {
    const log = getLogger();
    const { extensionContext } = ctx;
    const pool: Session[] = [];
    const seen = new Set<string>();
    const seenFiles = new Set<string>();

    // Strategy 1: user-configured sessionDir -- scan all workspaces in it
    const configDir = vscode.workspace
      .getConfiguration("agentLens")
      .get<string>("sessionDir");
    if (configDir) {
      log.debug(`Copilot global: scanning configured sessionDir = "${configDir}"`);
      // Try as a direct chatSessions dir first
      const direct = await readSessionsFromDir(configDir, this.sessionCache, seenFiles);
      if (direct.length > 0) {
        for (const s of direct) {
          s.projectName = currentWorkspaceName ?? undefined;
          s.isCurrentWorkspace = true;
        }
        mergeInto(pool, seen, direct);
      } else {
        // Scan as workspaceStorage root (all workspaces)
        const allFromConfig = await scanAllWorkspaceStorageDirs(configDir, currentWorkspaceName, this.sessionCache, seenFiles);
        mergeInto(pool, seen, allFromConfig);
      }
    }

    // Strategy 2: extension context storage root -- scan all hash dirs
    if (extensionContext.storageUri) {
      const hashDir = path.dirname(extensionContext.storageUri.fsPath);
      const storageRoot = path.dirname(hashDir);
      log.debug(`Copilot global: scanning storage root = "${storageRoot}"`);
      const allFromRoot = await scanAllWorkspaceStorageDirs(storageRoot, currentWorkspaceName, this.sessionCache, seenFiles);
      mergeInto(pool, seen, allFromRoot);
    }

    // Strategy 3: platform storage root (if different)
    const platformRoot = this.getPlatformStorageRoot();
    const currentStorageRoot = extensionContext.storageUri
      ? path.dirname(path.dirname(extensionContext.storageUri.fsPath))
      : null;
    if (platformRoot && platformRoot !== currentStorageRoot) {
      log.debug(`Copilot global: scanning platform root = "${platformRoot}"`);
      const allFromPlatform = await scanAllWorkspaceStorageDirs(platformRoot, currentWorkspaceName, this.sessionCache, seenFiles);
      mergeInto(pool, seen, allFromPlatform);
    }

    // Prune stale cache entries for files no longer discovered
    for (const key of this.sessionCache.keys()) {
      if (!seenFiles.has(key)) this.sessionCache.delete(key);
    }

    log.debug(`Copilot global: total ${pool.length} session(s) discovered`);
    return pool;
  }

  getWatchTargets(ctx: SessionDiscoveryContext): WatchTarget[] {
    const storageUri = ctx.extensionContext.storageUri;

    const discoverAll = vscode.workspace
      .getConfiguration("agentLens")
      .get<boolean>("discoverAllProjects", true) ?? true;

    if (discoverAll && storageUri) {
      const hashDir = path.dirname(storageUri.fsPath);
      const storageRoot = path.dirname(hashDir);
      return [
        {
          pattern: new vscode.RelativePattern(
            vscode.Uri.file(storageRoot),
            "*/chatSessions/*.jsonl",
          ),
          events: ["create", "change"],
        },
      ];
    }

    if (!storageUri) return [];

    // Anchor watcher to the workspace hash dir (parent of chatSessions/)
    // so it fires even when chatSessions/ doesn't exist yet at activation.
    const hashDir = path.dirname(storageUri.fsPath);
    return [
      {
        pattern: new vscode.RelativePattern(
          vscode.Uri.file(hashDir),
          "chatSessions/*.jsonl",
        ),
        events: ["create", "change"],
      },
    ];
  }
}
