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

describe("statusCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(readAllSessions).mockReturnValue([makeSession()]);
    vi.mocked(getLatestCycleDate).mockReturnValue("2025-01-01");
    vi.mocked(readConfig).mockReturnValue({ retroReminderAfterSessions: 0 });
    vi.mocked(getSessionsInCycle).mockReturnValue({ count: 1, lastCycleDate: "2025-01-01" });

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

  it("shows PATINA core estimate in the overview", async () => {
    await statusCommand();

    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("PATINA core (est.)");
    expect(logs).toContain("tokens");
  });

  it("shows a warning when PATINA core estimate exceeds the ~500 token target", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("A".repeat(2300));

    await statusCommand();

    const logs = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logs).toContain("above target (~500)");
  });

  it("calls assertInitialised before reading status data", async () => {
    await statusCommand();
    expect(assertInitialised).toHaveBeenCalledOnce();
  });
});
