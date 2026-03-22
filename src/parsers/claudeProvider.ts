import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  discoverClaudeSessions,
  discoverClaudeSessionsInDir,
  discoverAllClaudeProjects,
  encodeProjectPath,
} from "./claudeLocator.js";
import {
  parseClaudeSessionJsonl,
  buildSubagentTypeMap,
} from "./claudeSessionParser.js";
import type { SubagentInput } from "./claudeSessionParser.js";
import type { Session } from "../models/session.js";
import type {
  SessionProvider,
  SessionDiscoveryContext,
  WatchTarget,
} from "./sessionProvider.js";
import { getLogger } from "../logger.js";

/** Yield control to the event loop to prevent extension host unresponsiveness */
function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

interface ClaudeCacheEntry {
  mtimeMs: number;
  subagentMtimes: Map<string, number>;
  session: Session;
}

export class ClaudeSessionProvider implements SessionProvider {
  readonly name = "Claude";
  private sessionCache = new Map<string, ClaudeCacheEntry>();

  async discoverSessions(ctx: SessionDiscoveryContext): Promise<Session[]> {
    const log = getLogger();
    const { workspacePath } = ctx;

    const discoverAll = vscode.workspace
      .getConfiguration("agentLens")
      .get<boolean>("discoverAllProjects", true);

    let entries = [];

    if (discoverAll) {
      // Global mode: discover sessions from ALL Claude projects
      log.debug("Claude: global discovery mode (discoverAllProjects=true)");
      entries = await discoverAllClaudeProjects(workspacePath);

      // Also merge in user-configured claudeDir if set
      const configDir = vscode.workspace
        .getConfiguration("agentLens")
        .get<string>("claudeDir");
      if (configDir) {
        log.debug(`Claude: also scanning configured claudeDir = "${configDir}"`);
        const configEntries = await discoverClaudeSessionsInDir(configDir, workspacePath);
        const seen = new Set(entries.map((e) => e.fullPath));
        for (const entry of configEntries) {
          if (!seen.has(entry.fullPath)) {
            entries.push(entry);
          }
        }
      }
    } else {
      // Workspace-only mode: existing behavior
      const configDir = vscode.workspace
        .getConfiguration("agentLens")
        .get<string>("claudeDir");

      if (configDir) {
        log.debug(`Claude: scanning configured claudeDir = "${configDir}"`);
        const configEntries = await discoverClaudeSessionsInDir(configDir, workspacePath);
        log.debug(`  Found ${configEntries.length} session(s) via configured dir`);
        entries.push(...configEntries);
      }

      if (workspacePath) {
        const defaultEntries = await discoverClaudeSessions(workspacePath);
        log.debug(`  Found ${defaultEntries.length} session(s) via default path`);
        const seen = new Set(entries.map((e) => e.fullPath));
        for (const entry of defaultEntries) {
          if (!seen.has(entry.fullPath)) {
            entries.push(entry);
          }
        }
      }

      if (entries.length === 0) {
        if (!workspacePath && !configDir) {
          log.debug("Claude: no workspace path and no claudeDir configured, skipping");
        }
        return [];
      }
    }

    if (entries.length === 0) return [];

    log.debug(`Claude: parsing ${entries.length} session(s)`);
    const sessions: Session[] = [];
    const seenFiles = new Set<string>();

    let entryIndex = 0;
    for (const entry of entries) {
      // Yield every 5 entries to prevent blocking the event loop
      if (entryIndex > 0 && entryIndex % 5 === 0) {
        await yieldEventLoop();
      }
      entryIndex++;
      seenFiles.add(entry.fullPath);
      try {
        // Check cache by mtime to skip unchanged files
        const stats = await fs.stat(entry.fullPath);
        const cached = this.sessionCache.get(entry.fullPath);
        if (cached && cached.mtimeMs === stats.mtimeMs) {
          // Also validate subagent mtimes — if any subagent changed, fall through to re-parse
          const cachedSubPaths = new Set(cached.subagentMtimes.keys());
          const currentSubPaths = new Set(entry.subagentPaths);
          let subagentsUnchanged =
            cachedSubPaths.size === currentSubPaths.size &&
            [...currentSubPaths].every((p) => cachedSubPaths.has(p));
          if (subagentsUnchanged) {
            for (const subPath of entry.subagentPaths) {
              try {
                const subStats = await fs.stat(subPath);
                if (subStats.mtimeMs !== cached.subagentMtimes.get(subPath)) {
                  subagentsUnchanged = false;
                  break;
                }
              } catch {
                subagentsUnchanged = false;
                break;
              }
            }
          }
          if (subagentsUnchanged) {
            // Re-stamp metadata (may change between refreshes)
            if (entry.projectName) cached.session.projectName = entry.projectName;
            if (entry.isCurrentWorkspace !== undefined) cached.session.isCurrentWorkspace = entry.isCurrentWorkspace;
            sessions.push(cached.session);
            continue;
          }
        }

        const content = await fs.readFile(entry.fullPath, "utf-8");
        const typeMap = buildSubagentTypeMap(content);

        const subagentMtimes = new Map<string, number>();
        const subagents: SubagentInput[] = [];
        for (const subPath of entry.subagentPaths) {
          try {
            const subContent = await fs.readFile(subPath, "utf-8");
            const subStats = await fs.stat(subPath);
            subagentMtimes.set(subPath, subStats.mtimeMs);
            const agentId = path
              .basename(subPath, ".jsonl")
              .replace(/^agent-/, "");
            subagents.push({
              content: subContent,
              agentId,
              subagentType: typeMap.get(agentId) ?? null,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`  Skipping subagent file "${subPath}": ${msg}`);
          }
        }

        const session = await parseClaudeSessionJsonl(
          content,
          entry.summary,
          subagents.length > 0 ? subagents : undefined,
        );
        // Stamp project metadata from the locator entry
        if (entry.projectName) session.projectName = entry.projectName;
        if (entry.isCurrentWorkspace !== undefined) session.isCurrentWorkspace = entry.isCurrentWorkspace;
        this.sessionCache.set(entry.fullPath, { mtimeMs: stats.mtimeMs, subagentMtimes, session });
        sessions.push(session);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`  Skipping Claude session "${entry.fullPath}": ${msg}`);
      }
    }

    // Prune stale cache entries for files no longer discovered
    for (const key of this.sessionCache.keys()) {
      if (!seenFiles.has(key)) this.sessionCache.delete(key);
    }

    log.debug(`Claude: parsed ${sessions.length} session(s)`);
    return sessions;
  }

  getWatchTargets(ctx: SessionDiscoveryContext): WatchTarget[] {
    const { workspacePath } = ctx;
    const targets: WatchTarget[] = [];

    const discoverAll = vscode.workspace
      .getConfiguration("agentLens")
      .get<boolean>("discoverAllProjects", true);

    if (discoverAll) {
      // Global mode: watch all projects under ~/.claude/projects/
      const claudeProjectsRoot = path.join(os.homedir(), ".claude", "projects");
      targets.push(
        {
          pattern: new vscode.RelativePattern(
            vscode.Uri.file(claudeProjectsRoot),
            "**/*.jsonl",
          ),
          events: ["create", "change"],
        },
      );

      // Also watch user-configured claudeDir if set
      const configDir = vscode.workspace
        .getConfiguration("agentLens")
        .get<string>("claudeDir");
      if (configDir) {
        targets.push(
          {
            pattern: new vscode.RelativePattern(
              vscode.Uri.file(configDir),
              "**/*.jsonl",
            ),
            events: ["create", "change"],
          },
        );
      }
    } else {
      // Workspace-only mode: existing behavior

      // Watch user-configured dir if set
      const configDir = vscode.workspace
        .getConfiguration("agentLens")
        .get<string>("claudeDir");
      if (configDir) {
        targets.push(
          {
            pattern: new vscode.RelativePattern(
              vscode.Uri.file(configDir),
              "**/*.jsonl",
            ),
            events: ["create", "change"],
          },
        );
      }

      // Watch default location
      if (workspacePath) {
        const encoded = encodeProjectPath(workspacePath);
        const claudeProjectDir = path.join(
          os.homedir(),
          ".claude",
          "projects",
          encoded,
        );

        targets.push(
          {
            pattern: new vscode.RelativePattern(
              vscode.Uri.file(claudeProjectDir),
              "*.jsonl",
            ),
            events: ["create", "change"],
          },
          {
            pattern: new vscode.RelativePattern(
              vscode.Uri.file(claudeProjectDir),
              "*/subagents/agent-*.jsonl",
            ),
            events: ["create", "change"],
          },
        );
      }
    }

    return targets;
  }
}
