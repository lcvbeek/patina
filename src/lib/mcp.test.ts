import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isStale, activeServers, mcpSummaryText, type McpServer } from "./mcp.js";

function makeServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    name: "test-server",
    source: "plugin",
    scope: "global",
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

describe("isStale", () => {
  it("returns false when lastUpdated is undefined", () => {
    expect(isStale(makeServer({ lastUpdated: undefined }))).toBe(false);
  });

  it("returns false when updated recently", () => {
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(makeServer({ lastUpdated: recent }))).toBe(false);
  });

  it("returns false when updated exactly 89 days ago", () => {
    const d = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(makeServer({ lastUpdated: d }))).toBe(false);
  });

  it("returns true when updated 91 days ago", () => {
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(makeServer({ lastUpdated: old }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// activeServers
// ---------------------------------------------------------------------------

describe("activeServers", () => {
  it("returns only enabled servers", () => {
    const servers = [
      makeServer({ name: "a", enabled: true }),
      makeServer({ name: "b", enabled: false }),
      makeServer({ name: "c", enabled: true }),
    ];
    const result = activeServers(servers);
    expect(result.map((s) => s.name)).toEqual(["a", "c"]);
  });

  it("returns empty array when no servers are enabled", () => {
    expect(activeServers([makeServer({ enabled: false })])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(activeServers([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mcpSummaryText
// ---------------------------------------------------------------------------

describe("mcpSummaryText", () => {
  it("returns empty string when no active servers", () => {
    expect(mcpSummaryText([], [])).toBe("");
  });

  it("returns empty string when all servers are disabled", () => {
    const servers = [makeServer({ enabled: false })];
    expect(mcpSummaryText(servers, [])).toBe("");
  });

  it("includes server count and name", () => {
    const global = [makeServer({ name: "github", enabled: true })];
    const text = mcpSummaryText(global, []);
    expect(text).toContain("Active MCP servers: 1");
    expect(text).toContain("github");
  });

  it("includes project-scoped count when present", () => {
    const global = [makeServer({ name: "github", enabled: true })];
    const project = [makeServer({ name: "playwright", scope: "project", enabled: true })];
    const text = mcpSummaryText(global, project);
    expect(text).toContain("2 (1 global, 1 project-scoped)");
    expect(text).toContain("Project-scoped: playwright");
  });

  it("flags stale servers", () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const global = [makeServer({ name: "terraform", enabled: true, lastUpdated: old })];
    const text = mcpSummaryText(global, []);
    expect(text).toContain("Stale (>90 days since update): terraform");
  });

  it("adds bloat warning when more than 5 active servers", () => {
    const global = Array.from({ length: 6 }, (_, i) =>
      makeServer({ name: `server-${i}`, enabled: true }),
    );
    const text = mcpSummaryText(global, []);
    expect(text).toContain("6 active MCP servers");
    expect(text).toContain("context window");
  });

  it("does not add bloat warning for exactly 5 servers", () => {
    const global = Array.from({ length: 5 }, (_, i) =>
      makeServer({ name: `server-${i}`, enabled: true }),
    );
    const text = mcpSummaryText(global, []);
    expect(text).not.toContain("context window");
  });
});
