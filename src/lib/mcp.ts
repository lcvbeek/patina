import fs from "fs";
import path from "path";
import os from "os";

export interface McpServer {
  name: string;
  source: "direct" | "plugin" | "project";
  pluginId?: string;
  lastUpdated?: string; // ISO string
  scope: "global" | "project";
  enabled: boolean;
  needsAuth?: boolean;
}

const STALE_DAYS = 90;

function safeReadJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function extractServerNames(obj: Record<string, unknown>): string[] {
  // Handle both { mcpServers: { name: cfg } } and flat { name: cfg }
  const inner =
    obj.mcpServers && typeof obj.mcpServers === "object"
      ? (obj.mcpServers as Record<string, unknown>)
      : obj;
  return Object.keys(inner);
}

interface ProjectMcpState {
  disabledMcpServers: Set<string>;
  enabledMcpServers: Set<string>;
  projectMcpServers: Record<string, unknown>;
}

function readProjectMcpState(cwd: string): ProjectMcpState {
  const dotClaudeJson = safeReadJson<{
    projects?: Record<
      string,
      {
        disabledMcpServers?: string[];
        enabledMcpServers?: string[];
        mcpServers?: Record<string, unknown>;
      }
    >;
  }>(path.join(os.homedir(), ".claude.json"), {});

  const projectData = dotClaudeJson.projects?.[cwd] ?? {};
  return {
    disabledMcpServers: new Set(projectData.disabledMcpServers ?? []),
    enabledMcpServers: new Set(projectData.enabledMcpServers ?? []),
    projectMcpServers: projectData.mcpServers ?? {},
  };
}

function readAuthCache(): Set<string> {
  const cache = safeReadJson<Record<string, unknown>>(
    path.join(os.homedir(), ".claude", "mcp-needs-auth-cache.json"),
    {},
  );
  return new Set(Object.keys(cache));
}

export function readGlobalMcpServers(cwd: string = process.cwd()): McpServer[] {
  const home = os.homedir();
  const claudeDir = path.join(home, ".claude");
  const state = readProjectMcpState(cwd);
  const authNeeded = readAuthCache();
  const servers: McpServer[] = [];

  function isEnabled(name: string): boolean {
    if (state.disabledMcpServers.has(name)) return false;
    // If explicitly in enabledMcpServers, it's on; otherwise assume on (Claude Code default)
    return true;
  }

  // Directly-configured servers in ~/.claude/mcp.json
  const mcpJson = safeReadJson<Record<string, unknown>>(path.join(claudeDir, "mcp.json"), {});
  for (const name of extractServerNames(mcpJson)) {
    servers.push({
      name,
      source: "direct",
      scope: "global",
      enabled: isEnabled(name),
      needsAuth: authNeeded.has(name),
    });
  }

  // Directly-configured servers in ~/.claude.json top-level mcpServers (User MCPs)
  const dotClaudeJson = safeReadJson<{ mcpServers?: Record<string, unknown> }>(
    path.join(home, ".claude.json"),
    {},
  );
  if (dotClaudeJson.mcpServers) {
    for (const name of Object.keys(dotClaudeJson.mcpServers)) {
      if (!servers.find((s) => s.name === name)) {
        servers.push({
          name,
          source: "direct",
          scope: "global",
          enabled: isEnabled(name),
          needsAuth: authNeeded.has(name),
        });
      }
    }
  }

  // Plugin-contributed servers — Built-in MCPs, active by default when plugin is enabled
  const settings = safeReadJson<{ enabledPlugins?: Record<string, boolean> }>(
    path.join(claudeDir, "settings.json"),
    {},
  );
  const enabledPlugins = settings.enabledPlugins ?? {};

  const installedJson = safeReadJson<{
    plugins?: Record<
      string,
      Array<{ installPath: string; lastUpdated?: string; installedAt?: string }>
    >;
  }>(path.join(claudeDir, "plugins", "installed_plugins.json"), {});
  const installedPlugins = installedJson.plugins ?? {};

  const blocklistRaw = safeReadJson<unknown>(
    path.join(claudeDir, "plugins", "blocklist.json"),
    null,
  );
  const blocklist = new Set<string>(
    Array.isArray(blocklistRaw)
      ? (blocklistRaw as unknown[]).filter((x): x is string => typeof x === "string")
      : blocklistRaw && typeof blocklistRaw === "object"
        ? Object.keys(blocklistRaw as Record<string, unknown>)
        : [],
  );

  for (const [pluginId, isPluginEnabled] of Object.entries(enabledPlugins)) {
    if (!isPluginEnabled || blocklist.has(pluginId)) continue;

    const installs = installedPlugins[pluginId] ?? [];
    const latest = installs[0];
    if (!latest) continue;

    const mcpFilePath = path.join(latest.installPath, ".mcp.json");
    const pluginMcp = safeReadJson<Record<string, unknown>>(mcpFilePath, {});
    const lastUpdated = latest.lastUpdated ?? latest.installedAt;

    for (const serverName of extractServerNames(pluginMcp)) {
      if (servers.find((s) => s.name === serverName)) continue;
      // Plugin servers are Built-in MCPs — active unless individually disabled in this project
      const pluginPrefixed = `plugin:${pluginId.replace("@", ":")}:${serverName}`;
      const enabled =
        !state.disabledMcpServers.has(serverName) && !state.disabledMcpServers.has(pluginPrefixed);
      servers.push({
        name: serverName,
        source: "plugin",
        pluginId,
        lastUpdated,
        scope: "global",
        enabled,
        needsAuth: authNeeded.has(serverName),
      });
    }
  }

  return servers;
}

export function readProjectMcpServers(cwd: string = process.cwd()): McpServer[] {
  const state = readProjectMcpState(cwd);
  const authNeeded = readAuthCache();
  const servers: McpServer[] = [];

  // Project-scoped servers from ~/.claude.json projects[cwd].mcpServers
  for (const name of Object.keys(state.projectMcpServers)) {
    servers.push({
      name,
      source: "project",
      scope: "project",
      enabled: !state.disabledMcpServers.has(name),
      needsAuth: authNeeded.has(name),
    });
  }

  // Project-scoped servers from .claude/settings.json
  const projectSettings = safeReadJson<{ mcpServers?: Record<string, unknown> }>(
    path.join(cwd, ".claude", "settings.json"),
    {},
  );
  if (projectSettings.mcpServers) {
    for (const name of Object.keys(projectSettings.mcpServers)) {
      if (!servers.find((s) => s.name === name)) {
        servers.push({
          name,
          source: "project",
          scope: "project",
          enabled: !state.disabledMcpServers.has(name),
          needsAuth: authNeeded.has(name),
        });
      }
    }
  }

  // Project-scoped servers from .mcp.json at project root
  const projectMcp = safeReadJson<Record<string, unknown>>(path.join(cwd, ".mcp.json"), {});
  for (const name of extractServerNames(projectMcp)) {
    if (!servers.find((s) => s.name === name)) {
      servers.push({
        name,
        source: "project",
        scope: "project",
        enabled: !state.disabledMcpServers.has(name),
        needsAuth: authNeeded.has(name),
      });
    }
  }

  return servers;
}

export function isStale(server: McpServer): boolean {
  if (!server.lastUpdated) return false;
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  return new Date(server.lastUpdated).getTime() < cutoff;
}

export function activeServers(servers: McpServer[]): McpServer[] {
  return servers.filter((s) => s.enabled);
}

export function mcpSummaryText(globalServers: McpServer[], projectServers: McpServer[]): string {
  const activeGlobal = activeServers(globalServers);
  const activeProject = activeServers(projectServers);
  const totalActive = activeGlobal.length + activeProject.length;

  if (totalActive === 0) return "";

  const staleList = activeGlobal.filter(isStale);

  const lines: string[] = [
    "## MCP Server Context",
    `Active MCP servers: ${totalActive} (${activeGlobal.length} global${activeProject.length > 0 ? `, ${activeProject.length} project-scoped` : ""})`,
  ];

  if (staleList.length > 0) {
    lines.push(`Stale (>90 days since update): ${staleList.map((s) => s.name).join(", ")}`);
  }

  const globalNames = activeGlobal.map((s) => s.name).join(", ");
  if (globalNames) lines.push(`Global: ${globalNames}`);

  const projectNames = activeProject.map((s) => s.name).join(", ");
  if (projectNames) lines.push(`Project-scoped: ${projectNames}`);

  if (totalActive > 5) {
    lines.push(
      `\nNote: ${totalActive} active MCP servers — each loads tool definitions into the context window at session start. If token averages are elevated, MCP server count may be a contributing factor.`,
    );
  }

  return lines.join("\n");
}
