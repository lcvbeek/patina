import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionSummary } from "../lib/storage.js";

vi.mock("../lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage.js")>();
  return {
    ...actual,
    assertInitialised: vi.fn(),
    readAllSessions: vi.fn(),
    getLatestCycleDate: vi.fn(),
    readConfig: vi.fn(),
    getSessionsInCycle: vi.fn(),
    LIVING_DOC_FILE: ".patina/PATINA.md",
    CORE_MAX_LINES: 80,
  };
});

vi.mock("../lib/mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mcp.js")>();
  return {
    ...actual,
    readGlobalMcpServers: vi.fn(() => []),
    readProjectMcpServers: vi.fn(() => []),
    activeServers: vi.fn(() => []),
    isStale: vi.fn(() => false),
  };
});

vi.mock("../lib/metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/metrics.js")>();
  return {
    ...actual,
    computeAggregates: vi.fn(),
    computeTrend: vi.fn(() => null),
    formatNumber: vi.fn((n: number) => String(n)),
    formatDate: vi.fn((s: string) => s),
    trendArrow: vi.fn((n: number | null) => (n === null ? "—" : `${n}%`)),
  };
});

vi.mock("../lib/token-estimate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/token-estimate.js")>();
  return {
    ...actual,
    estimateTextTokens: vi.fn(() => ({ estimatedTokens: 200, lines: 20, chars: 900 })),
    exceedsPatinaCoreTokenTarget: vi.fn(() => false),
    PATINA_CORE_TOKEN_TARGET: 500,
  };
});

vi.mock("../lib/context-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/context-snapshot.js")>();
  return {
    ...actual,
    modelContextWindow: vi.fn(() => null),
    systemPromptSizeLabel: vi.fn(() => "Lean"),
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ""),
    },
  };
});

import { statusCommand } from "./status.js";
import {
  assertInitialised,
  readAllSessions,
  getLatestCycleDate,
  readConfig,
  getSessionsInCycle,
} from "../lib/storage.js";
import { activeServers, readGlobalMcpServers, readProjectMcpServers, isStale } from "../lib/mcp.js";
import { computeAggregates, computeTrend } from "../lib/metrics.js";
import { estimateTextTokens, exceedsPatinaCoreTokenTarget } from "../lib/token-estimate.js";
import { systemPromptSizeLabel } from "../lib/context-snapshot.js";
import fs from "fs";

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: "session-1",
    project: "patina",
    timestamp: "2025-01-15T00:00:00Z",
    turn_count: 6,
    estimated_tokens: 1200,
    tool_calls: { Read: 3 },
    had_rework: false,
    ingested_at: "2025-01-15T00:00:00Z",
    ...overrides,
  };
}

const BASE_AGG = {
  total_sessions: 1,
  total_tokens: 1200,
  avg_tokens_per_session: 1200,
  rework_sessions: 0,
  rework_rate_pct: 0,
  tool_usage: [],
  sessions_by_project: { patina: 1 },
  date_range: { earliest: "2025-01-15", latest: "2025-01-15" },
};

describe("statusCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(readAllSessions).mockReturnValue([makeSession()]);
    vi.mocked(getLatestCycleDate).mockReturnValue("2025-01-01");
    vi.mocked(readConfig).mockReturnValue({ retroReminderAfterSessions: 0 });
    vi.mocked(getSessionsInCycle).mockReturnValue({ count: 1, lastCycleDate: "2025-01-01" });
    vi.mocked(computeAggregates).mockReturnValue(BASE_AGG as ReturnType<typeof computeAggregates>);
    vi.mocked(computeTrend).mockReturnValue(null);
    vi.mocked(activeServers).mockReturnValue([]);
    vi.mocked(readGlobalMcpServers).mockReturnValue([]);
    vi.mocked(readProjectMcpServers).mockReturnValue([]);
    vi.mocked(estimateTextTokens).mockReturnValue({ estimatedTokens: 200, lines: 20, chars: 900 });
    vi.mocked(exceedsPatinaCoreTokenTarget).mockReturnValue(false);

    vi.mocked(fs.existsSync).mockImplementation((p: string | Buffer | URL) =>
      String(p).includes("PATINA.md"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      "# AI Operating Constitution\n\n## 1. Working Agreements\n",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls assertInitialised before reading status data", async () => {
    await statusCommand();
    expect(assertInitialised).toHaveBeenCalledOnce();
  });

  it("shows no sessions message and returns early when no sessions", async () => {
    vi.mocked(readAllSessions).mockReturnValue([]);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("patina ingest");
  });

  it("shows PATINA core estimate in the overview when file exists", async () => {
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("PATINA core (est.)");
    expect(logs).toContain("tokens");
  });

  it("does not show PATINA core estimate when no living doc", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).not.toContain("PATINA core (est.)");
  });

  // ── Trend section ────────────────────────────────────────────────────────────

  it("shows need ≥ 4 sessions note when fewer than 4 sessions and trend is null", async () => {
    vi.mocked(computeTrend).mockReturnValue(null);
    vi.mocked(readAllSessions).mockReturnValue([makeSession()]);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("Not enough data");
  });

  it("does not show trend section when sessions >= 4 and trend is null", async () => {
    vi.mocked(computeTrend).mockReturnValue(null);
    vi.mocked(readAllSessions).mockReturnValue([
      makeSession({ session_id: "s1" }),
      makeSession({ session_id: "s2" }),
      makeSession({ session_id: "s3" }),
      makeSession({ session_id: "s4" }),
    ]);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).not.toContain("Not enough data");
  });

  it("shows trend section when computeTrend returns data", async () => {
    vi.mocked(computeTrend).mockReturnValue({
      token_delta_pct: 5,
      rework_delta_pct: -10,
      previous: { total_sessions: 2, avg_tokens_per_session: 1000, rework_rate_pct: 20 },
      current: { total_sessions: 2, avg_tokens_per_session: 1050, rework_rate_pct: 10 },
    } as ReturnType<typeof computeTrend>);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("Trend");
    expect(logs).toContain("Previous period");
  });

  // ── Tool usage section ───────────────────────────────────────────────────────

  it("does not show tool usage section when tool_usage is empty", async () => {
    vi.mocked(computeAggregates).mockReturnValue({
      ...BASE_AGG,
      tool_usage: [],
    } as ReturnType<typeof computeAggregates>);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).not.toContain("Top tool usage");
  });

  it("shows tool usage section when tool_usage has entries", async () => {
    vi.mocked(computeAggregates).mockReturnValue({
      ...BASE_AGG,
      tool_usage: [
        { tool: "Read", count: 10 },
        { tool: "Edit", count: 5 },
      ],
    } as ReturnType<typeof computeAggregates>);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("Top tool usage");
    expect(logs).toContain("Read");
  });

  // ── Sessions by project ──────────────────────────────────────────────────────

  it("does not show sessions by project when only 1 project", async () => {
    vi.mocked(computeAggregates).mockReturnValue({
      ...BASE_AGG,
      sessions_by_project: { patina: 1 },
    } as ReturnType<typeof computeAggregates>);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).not.toContain("Sessions by project");
  });

  it("shows sessions by project when 2+ projects", async () => {
    vi.mocked(computeAggregates).mockReturnValue({
      ...BASE_AGG,
      total_sessions: 3,
      sessions_by_project: { patina: 2, "other-project": 1 },
    } as ReturnType<typeof computeAggregates>);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("Sessions by project");
    expect(logs).toContain("other-project");
  });

  // ── Rework sessions section ──────────────────────────────────────────────────

  it("does not show rework section when rework_sessions is 0", async () => {
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).not.toContain("Sessions with rework detected");
  });

  it("shows rework section and lists sessions when rework_sessions > 0", async () => {
    const reworkSessions = [1, 2, 3].map((i) =>
      makeSession({ session_id: `rw-${i}`, had_rework: true }),
    );
    vi.mocked(readAllSessions).mockReturnValue(reworkSessions);
    vi.mocked(computeAggregates).mockReturnValue({
      ...BASE_AGG,
      rework_sessions: 3,
      rework_rate_pct: 100,
    } as ReturnType<typeof computeAggregates>);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("Sessions with rework detected");
  });

  it("shows overflow message when more than 5 rework sessions", async () => {
    const reworkSessions = Array.from({ length: 6 }, (_, i) =>
      makeSession({ session_id: `rw-${i}`, had_rework: true }),
    );
    vi.mocked(readAllSessions).mockReturnValue(reworkSessions);
    vi.mocked(computeAggregates).mockReturnValue({
      ...BASE_AGG,
      rework_sessions: 6,
      rework_rate_pct: 100,
    } as ReturnType<typeof computeAggregates>);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("and 1 more");
  });

  // ── Context load section ─────────────────────────────────────────────────────

  it("shows active MCP servers count when servers are active", async () => {
    vi.mocked(activeServers).mockReturnValue([
      { name: "computer-use", enabled: true, source: "direct" as const },
      { name: "slack", enabled: true, source: "direct" as const },
    ]);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("Active MCP servers");
  });

  it("shows many MCP servers warning when totalActive > 5", async () => {
    const servers = Array.from({ length: 6 }, (_, i) => ({
      name: `server-${i}`,
      enabled: true,
      source: "direct" as const,
    }));
    vi.mocked(activeServers).mockReturnValue(servers);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("active MCP servers");
  });

  it("shows stale plugin warning when isStale returns true", async () => {
    vi.mocked(readGlobalMcpServers).mockReturnValue([
      { name: "old-plugin", enabled: true, source: "plugin" as const },
    ]);
    vi.mocked(activeServers).mockReturnValue([
      { name: "old-plugin", enabled: true, source: "plugin" as const },
    ]);
    vi.mocked(isStale).mockReturnValue(true);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("stale plugin");
  });

  it("shows system prompt size label when sessions have contextSnapshot", async () => {
    vi.mocked(readAllSessions).mockReturnValue([
      makeSession({
        contextSnapshot: { systemPromptTokens: 15000, mcpServers: [], deferredTools: [] },
      }),
    ]);
    vi.mocked(systemPromptSizeLabel).mockReturnValue("Heavy");
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("System prompt");
  });

  it("shows available-not-enabled plugins when globalMcp has disabled entries", async () => {
    vi.mocked(readGlobalMcpServers).mockReturnValue([
      { name: "disabled-plugin", enabled: false, source: "plugin" as const },
    ]);
    vi.mocked(activeServers)
      .mockReturnValueOnce([]) // global active
      .mockReturnValueOnce([]); // project active
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("available (not enabled)");
  });

  // ── Footer ───────────────────────────────────────────────────────────────────

  it("shows no cycles message when getLatestCycleDate returns null", async () => {
    vi.mocked(getLatestCycleDate).mockReturnValue(null);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("No cycles yet");
  });

  it("shows last cycle date when getLatestCycleDate returns a date", async () => {
    vi.mocked(getLatestCycleDate).mockReturnValue("2026-01-01");
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("Last cycle:");
    expect(logs).toContain("2026-01-01");
  });

  // ── Retro reminder ───────────────────────────────────────────────────────────

  it("shows retro reminder when session count meets threshold", async () => {
    vi.mocked(readConfig).mockReturnValue({ retroReminderAfterSessions: 10 });
    vi.mocked(getSessionsInCycle).mockReturnValue({ count: 10, lastCycleDate: "2025-01-01" });
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("patina reflect");
  });

  it("does not show retro reminder when count is below threshold", async () => {
    vi.mocked(readConfig).mockReturnValue({ retroReminderAfterSessions: 10 });
    vi.mocked(getSessionsInCycle).mockReturnValue({ count: 5, lastCycleDate: "2025-01-01" });
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).not.toContain("patina reflect");
  });

  it("suppresses retro reminder when threshold is 0", async () => {
    vi.mocked(readConfig).mockReturnValue({ retroReminderAfterSessions: 0 });
    vi.mocked(getSessionsInCycle).mockReturnValue({ count: 20, lastCycleDate: "2025-01-01" });
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).not.toContain("patina reflect");
  });

  // ── PATINA.md warnings ───────────────────────────────────────────────────────

  it("shows token target warning when exceedsPatinaCoreTokenTarget returns true", async () => {
    vi.mocked(exceedsPatinaCoreTokenTarget).mockReturnValue(true);
    vi.mocked(estimateTextTokens).mockReturnValue({ estimatedTokens: 800, lines: 50, chars: 3600 });
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("above target");
  });

  it("shows line count warning when PATINA.md exceeds CORE_MAX_LINES", async () => {
    vi.mocked(estimateTextTokens).mockReturnValue({ estimatedTokens: 200, lines: 90, chars: 900 });
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("over the");
    expect(logs).toContain("line limit");
  });

  it("shows no warnings when living doc does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await statusCommand();
    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).not.toContain("above target");
    expect(logs).not.toContain("line limit");
  });
});
