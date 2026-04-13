import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  compressSessionsForPrompt,
  buildSynthesisPrompt,
  buildCycleMarkdown,
  type SynthesisResponse,
} from "./run.js";
import type { SessionSummary, Capture, Reflection } from "../lib/storage.js";

// ---------------------------------------------------------------------------
// Mocks — registered before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("../lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage.js")>();
  return {
    ...actual,
    assertInitialised: vi.fn(),
    readAllSessions: vi.fn(),
    readCaptures: vi.fn(),
    readReflections: vi.fn(),
    writePendingDiff: vi.fn(),
    writeCycleFile: vi.fn(),
    getLatestCycleDate: vi.fn(),
    loadSpokeFiles: vi.fn(() => ""),
    loadOpportunityBacklog: vi.fn(() => null),
    LIVING_DOC_FILE: ".patina/PATINA.md",
    CORE_MAX_LINES: 80,
    CORE_MAX_CHARS: 3200,
  };
});

vi.mock("./ingest.js", () => ({
  runIngest: vi.fn(() => ({ ingested: 0, skipped: 0, errors: 0 })),
}));

vi.mock("./onboard.js", () => ({
  onboardCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/claude.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/claude.js")>();
  return {
    ...actual,
    callClaudeForJson: vi.fn(),
    ANALYST_PREAMBLE: "ANALYST_PREAMBLE\n",
    patinaMdEditingRules: vi.fn(() => "PATINA_RULES\n"),
  };
});

vi.mock("../lib/ui.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ui.js")>();
  return { ...actual, startSpinner: vi.fn(() => vi.fn()) };
});

vi.mock("../lib/mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mcp.js")>();
  return {
    ...actual,
    readGlobalMcpServers: vi.fn(() => ({})),
    readProjectMcpServers: vi.fn(() => ({})),
    mcpSummaryText: vi.fn(() => ""),
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runCommand } from "./run.js";
import {
  assertInitialised,
  readAllSessions,
  readCaptures,
  readReflections,
  writePendingDiff,
  writeCycleFile,
  getLatestCycleDate,
  loadSpokeFiles,
  loadOpportunityBacklog,
} from "../lib/storage.js";
import { runIngest } from "./ingest.js";
import { onboardCommand } from "./onboard.js";
import { callClaudeForJson } from "../lib/claude.js";
import { startSpinner } from "../lib/ui.js";
import fs from "fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: "test-session",
    project: "test-project",
    timestamp: "2025-01-15T00:00:00Z",
    turn_count: 4,
    estimated_tokens: 1000,
    tool_calls: {},
    had_rework: false,
    ingested_at: "2025-01-15T00:00:00Z",
    ...overrides,
  };
}

function makeReflection(overrides: Partial<Reflection> = {}): Reflection {
  return {
    id: "test-reflection",
    author: "Leo",
    timestamp: "2025-01-15T10:00:00Z",
    cycleStart: "2025-01-01",
    answers: { overall_feel: "Good", went_well: "Everything" },
    ...overrides,
  };
}

const MOCK_SYNTHESIS: SynthesisResponse = {
  cycle_summary: "A productive cycle with consistent progress.",
  patterns: [
    {
      pattern: "Heavy read usage",
      frequency: "Every session",
      interpretation: "Explores before editing",
    },
  ],
  coaching_insight: {
    observation: "Sessions start with many reads.",
    what_it_suggests: "Could benefit from targeted reads.",
    one_thing_to_try: "Use line ranges instead of full file reads.",
  },
  proposed_instruction: {
    rationale: "Token usage can be reduced.",
    diff: "- Prefer targeted reads with line ranges",
    section: "1. Working Agreements",
  },
  opportunity: {
    observation: "Manual status checks are frequent.",
    suggestion: "Automate status reporting.",
    effort: "low",
  },
};

// ---------------------------------------------------------------------------
// compressSessionsForPrompt
// ---------------------------------------------------------------------------

describe("compressSessionsForPrompt", () => {
  it('returns "(no sessions)" for an empty array', () => {
    expect(compressSessionsForPrompt([])).toBe("(no sessions)");
  });

  it("includes a header and a row for a single session", () => {
    const result = compressSessionsForPrompt([makeSession()]);
    expect(result).toContain("Total sessions: 1");
    expect(result).toContain("2025-01-15");
    expect(result).toContain("test-project");
  });

  it("shows top 3 tools sorted by count", () => {
    const session = makeSession({
      tool_calls: { Read: 10, Edit: 5, Bash: 3, Glob: 1 },
    });
    const result = compressSessionsForPrompt([session]);
    expect(result).toContain("Read:10");
    expect(result).toContain("Edit:5");
    expect(result).toContain("Bash:3");
    expect(result).not.toContain("Glob:1");
  });

  it('shows "none" when session has no tool calls', () => {
    const result = compressSessionsForPrompt([makeSession({ tool_calls: {} })]);
    expect(result).toContain("none");
  });

  it('shows "yes" in rework column for sessions with rework', () => {
    const result = compressSessionsForPrompt([makeSession({ had_rework: true })]);
    expect(result).toContain("yes");
  });

  it('shows "no" in rework column for sessions without rework', () => {
    const result = compressSessionsForPrompt([makeSession({ had_rework: false })]);
    expect(result).toContain("no");
  });

  it("limits to 30 rows and adds overflow message for 31 sessions", () => {
    const sessions = Array.from({ length: 31 }, (_, i) =>
      makeSession({ session_id: String(i), project: "proj" }),
    );
    const result = compressSessionsForPrompt(sessions);
    expect(result).toContain("… and 1 more sessions");
    const dataRows = result.split("\n").filter((l) => /\d{4}-\d{2}-\d{2}/.test(l));
    expect(dataRows.length).toBe(30);
  });

  it("does not show overflow message for exactly 30 sessions", () => {
    const sessions = Array.from({ length: 30 }, (_, i) =>
      makeSession({ session_id: String(i), project: "proj" }),
    );
    const result = compressSessionsForPrompt(sessions);
    expect(result).not.toContain("more sessions");
  });

  it("uses projectAlias when available instead of full project path", () => {
    const session = makeSession({ project: "/long/path/to/project", projectAlias: "project" });
    const result = compressSessionsForPrompt([session]);
    expect(result).toContain("project");
  });

  it("uses author field when available", () => {
    const session = makeSession({ author: "Alice" });
    const result = compressSessionsForPrompt([session]);
    expect(result).toContain("Alice");
  });

  it('shows em dash "—" when author is absent', () => {
    const session = makeSession({ author: undefined });
    const result = compressSessionsForPrompt([session]);
    expect(result).toContain("—");
  });

  it("truncates project name to 20 chars when no alias set", () => {
    const session = makeSession({
      project: "this-is-a-very-long-project-name-exceeding-twenty-chars",
      projectAlias: undefined,
    });
    const result = compressSessionsForPrompt([session]);
    // Should not contain the full 50-char project name in the data row
    const dataRow = result.split("\n").find((l) => /\d{4}-\d{2}-\d{2}/.test(l)) ?? "";
    expect(dataRow.includes("this-is-a-very-long-")).toBe(true);
    expect(dataRow.includes("this-is-a-very-long-project-name-exceeding-twenty-chars")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSynthesisPrompt
// ---------------------------------------------------------------------------

describe("buildSynthesisPrompt", () => {
  const baseParams = {
    cycleStart: "2025-01-01",
    cycleEnd: "2025-01-15",
    sessionCount: 3,
    sessions: [makeSession()],
    captures: [] as Capture[],
    reflections: [makeReflection()],
    livingDoc: "# AI Operating Constitution\n\n## 1. Working Agreements\n",
    lastCycleDate: "2025-01-01" as string | null,
  };

  it("contains the cycle date range", () => {
    const prompt = buildSynthesisPrompt(baseParams);
    expect(prompt).toContain("2025-01-01");
    expect(prompt).toContain("2025-01-15");
  });

  it("contains the Metrics section", () => {
    const prompt = buildSynthesisPrompt(baseParams);
    expect(prompt).toContain("## Metrics");
    expect(prompt).toContain("Sessions: 3");
  });

  it("contains reflection Q&A", () => {
    const prompt = buildSynthesisPrompt(baseParams);
    expect(prompt).toContain("## Reflection Answers");
    expect(prompt).toContain("A: Good");
    expect(prompt).toContain("A: Everything");
  });

  it("does not include captures section when captures array is empty", () => {
    const prompt = buildSynthesisPrompt(baseParams);
    expect(prompt).not.toContain("## Notable Moments Captured This Cycle");
  });

  it("includes captures section when captures are present", () => {
    const capture: Capture = {
      id: "cap-1",
      text: "Something notable happened",
      tag: "went-well",
      author: "Leo",
      timestamp: "2025-01-10T10:00:00Z",
    };
    const prompt = buildSynthesisPrompt({ ...baseParams, captures: [capture] });
    expect(prompt).toContain("## Notable Moments Captured This Cycle");
    expect(prompt).toContain("Something notable happened");
  });

  it("includes capture tag in the captures section", () => {
    const capture: Capture = {
      id: "cap-2",
      text: "Near miss with data loss",
      tag: "near-miss",
      author: "Leo",
      timestamp: "2025-01-11T10:00:00Z",
    };
    const prompt = buildSynthesisPrompt({ ...baseParams, captures: [capture] });
    expect(prompt).toContain("[near-miss]");
  });

  it("does not include tag brackets when capture has no tag", () => {
    const capture: Capture = {
      id: "cap-3",
      text: "Untagged event",
      author: "Leo",
      timestamp: "2025-01-12T10:00:00Z",
    };
    const prompt = buildSynthesisPrompt({ ...baseParams, captures: [capture] });
    expect(prompt).toContain("Untagged event");
    expect(prompt).not.toContain("[undefined]");
  });

  it('shows "Not enough data" when trend analysis is insufficient', () => {
    const prompt = buildSynthesisPrompt({ ...baseParams, sessions: [makeSession()] });
    expect(prompt).toContain("Not enough data");
  });

  it("includes the JSON schema block at the end", () => {
    const prompt = buildSynthesisPrompt(baseParams);
    expect(prompt).toContain('"cycle_summary"');
    expect(prompt).toContain('"proposed_instruction"');
  });

  it("mentions first cycle when lastCycleDate is null", () => {
    const prompt = buildSynthesisPrompt({ ...baseParams, lastCycleDate: null });
    expect(prompt).toContain("First cycle");
  });

  it("mentions previous cycle date when lastCycleDate is set", () => {
    const prompt = buildSynthesisPrompt(baseParams);
    expect(prompt).toContain("Previous cycle: 2025-01-01");
  });

  it("includes Session Detail section header", () => {
    const prompt = buildSynthesisPrompt(baseParams);
    expect(prompt).toContain("## Session Detail");
  });

  it("includes living doc content", () => {
    const prompt = buildSynthesisPrompt(baseParams);
    expect(prompt).toContain("## 1. Working Agreements");
  });

  it("includes (no reflections provided) when reflections array is empty", () => {
    const prompt = buildSynthesisPrompt({ ...baseParams, reflections: [] });
    expect(prompt).toContain("(no reflections provided)");
  });

  it("formats multiple reflections with author and date headers", () => {
    const reflections = [
      makeReflection({ author: "Alice", timestamp: "2025-01-10T00:00:00Z" }),
      makeReflection({
        id: "r2",
        author: "Bob",
        timestamp: "2025-01-12T00:00:00Z",
        answers: { overall_feel: "Mixed" },
      }),
    ];
    const prompt = buildSynthesisPrompt({ ...baseParams, reflections });
    expect(prompt).toContain("### Alice (2025-01-10)");
    expect(prompt).toContain("### Bob (2025-01-12)");
  });

  it("includes trend data when sufficient sessions are provided", () => {
    // Need enough sessions for computeTrend to return data (requires >= 4)
    const sessions = Array.from({ length: 6 }, (_, i) =>
      makeSession({
        session_id: `s${i}`,
        timestamp: `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        estimated_tokens: 1000 + i * 100,
      }),
    );
    const prompt = buildSynthesisPrompt({ ...baseParams, sessions });
    // Should NOT show "Not enough data" when there are enough sessions
    expect(prompt).not.toContain("Not enough data for trend analysis.");
  });
});

// ---------------------------------------------------------------------------
// buildCycleMarkdown
// ---------------------------------------------------------------------------

describe("buildCycleMarkdown", () => {
  const baseParams = {
    date: "2025-01-15",
    cycleStart: "2025-01-01",
    cycleEnd: "2025-01-15",
    reflections: [makeReflection({ answers: { overall_feel: "Great cycle" } })],
    synthesis: MOCK_SYNTHESIS,
    sessions: [makeSession({ estimated_tokens: 2000 })],
  };

  it("starts with the Retro Cycle heading", () => {
    const md = buildCycleMarkdown(baseParams);
    expect(md).toMatch(/^# Retro Cycle — 2025-01-15/);
  });

  it("contains the Metrics Snapshot table", () => {
    const md = buildCycleMarkdown(baseParams);
    expect(md).toContain("## Metrics Snapshot");
    expect(md).toContain("| Total sessions | 1 |");
  });

  it("contains the cycle summary from synthesis", () => {
    const md = buildCycleMarkdown(baseParams);
    expect(md).toContain(MOCK_SYNTHESIS.cycle_summary);
  });

  it("numbers patterns correctly", () => {
    const synthesis: SynthesisResponse = {
      ...MOCK_SYNTHESIS,
      patterns: [
        { pattern: "Pattern A", frequency: "often", interpretation: "good" },
        { pattern: "Pattern B", frequency: "rarely", interpretation: "ok" },
      ],
    };
    const md = buildCycleMarkdown({ ...baseParams, synthesis });
    expect(md).toContain("### Pattern 1: Pattern A");
    expect(md).toContain("### Pattern 2: Pattern B");
  });

  it("shows placeholder when no patterns", () => {
    const synthesis: SynthesisResponse = { ...MOCK_SYNTHESIS, patterns: [] };
    const md = buildCycleMarkdown({ ...baseParams, synthesis });
    expect(md).toContain("_No patterns identified._");
  });

  it("shows placeholder when no tool usage recorded", () => {
    const md = buildCycleMarkdown({ ...baseParams, sessions: [makeSession({ tool_calls: {} })] });
    expect(md).toContain("_No tool usage recorded._");
  });

  it("shows tool usage when tools were used", () => {
    const md = buildCycleMarkdown({
      ...baseParams,
      sessions: [makeSession({ tool_calls: { Read: 5 } })],
    });
    expect(md).toContain("Read: 5 calls");
  });

  it("contains the proposed instruction section", () => {
    const md = buildCycleMarkdown(baseParams);
    expect(md).toContain("## Proposed Instruction Change");
    expect(md).toContain(MOCK_SYNTHESIS.proposed_instruction.diff);
  });

  it("contains the coaching insight section", () => {
    const md = buildCycleMarkdown(baseParams);
    expect(md).toContain("## Coaching Insight");
    expect(md).toContain(MOCK_SYNTHESIS.coaching_insight.observation);
    expect(md).toContain(MOCK_SYNTHESIS.coaching_insight.one_thing_to_try);
  });

  it("contains opportunity section", () => {
    const md = buildCycleMarkdown(baseParams);
    expect(md).toContain("## Opportunity");
    expect(md).toContain(MOCK_SYNTHESIS.opportunity.suggestion);
    expect(md).toContain(MOCK_SYNTHESIS.opportunity.effort);
  });

  it("shows _No reflections recorded_ when reflections array is empty", () => {
    const md = buildCycleMarkdown({ ...baseParams, reflections: [] });
    expect(md).toContain("_No reflections recorded for this cycle._");
  });

  it("formats single reflection as flat Q&A without author header", () => {
    const md = buildCycleMarkdown(baseParams);
    expect(md).toContain("Great cycle");
    // Single reflection should not have an ### author header
    expect(md).not.toContain("### Leo");
  });

  it("formats multiple reflections with author headers", () => {
    const reflections = [
      makeReflection({ author: "Alice", answers: { overall_feel: "Good" } }),
      makeReflection({
        id: "r2",
        author: "Bob",
        timestamp: "2025-01-16T00:00:00Z",
        answers: { overall_feel: "OK" },
      }),
    ];
    const md = buildCycleMarkdown({ ...baseParams, reflections });
    expect(md).toContain("### Alice");
    expect(md).toContain("### Bob");
  });

  it("includes the generated-by line in the header comment", () => {
    const md = buildCycleMarkdown(baseParams);
    expect(md).toContain("Generated by `patina run`");
  });

  it("shows cycle period and session count in header", () => {
    const md = buildCycleMarkdown(baseParams);
    expect(md).toContain("Cycle period: 2025-01-01 → 2025-01-15");
    expect(md).toContain("Sessions analysed: 1");
  });

  it("limits top tools to 5 in the metric snapshot", () => {
    const session = makeSession({
      tool_calls: { Read: 10, Edit: 9, Bash: 8, Glob: 7, Write: 6, Search: 5 },
    });
    const md = buildCycleMarkdown({ ...baseParams, sessions: [session] });
    expect(md).toContain("Read: 10 calls");
    expect(md).toContain("Edit: 9 calls");
    // The 6th tool should not appear in the markdown top tools list
    expect(md).not.toContain("Search: 5 calls");
  });
});

// ---------------------------------------------------------------------------
// runCommand — integration tests
// ---------------------------------------------------------------------------

describe("runCommand", () => {
  const mockStopSpinner = vi.fn();

  class ProcessExitError extends Error {
    constructor(public code: number | undefined) {
      super(`process.exit(${code})`);
      this.name = "ProcessExitError";
    }
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new ProcessExitError(code);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default happy-path mocks
    vi.mocked(runIngest).mockReturnValue({ ingested: 0, skipped: 0, errors: 0 });
    vi.mocked(getLatestCycleDate).mockReturnValue("2025-01-01");
    vi.mocked(readAllSessions).mockReturnValue([makeSession()]);
    vi.mocked(readCaptures).mockReturnValue([]);
    vi.mocked(readReflections).mockReturnValue([makeReflection()]);
    vi.mocked(writePendingDiff).mockImplementation(() => {});
    vi.mocked(writeCycleFile).mockImplementation(() => {});
    vi.mocked(loadSpokeFiles).mockReturnValue("");
    vi.mocked(loadOpportunityBacklog).mockReturnValue(null);
    vi.mocked(callClaudeForJson).mockResolvedValue(MOCK_SYNTHESIS);
    vi.mocked(startSpinner).mockReturnValue(mockStopSpinner);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue("# AI Operating Constitution\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls runIngest on startup for auto-ingestion", async () => {
    await runCommand();
    expect(runIngest).toHaveBeenCalledOnce();
  });

  it("logs auto-ingest count when new sessions are found", async () => {
    vi.mocked(runIngest).mockReturnValue({ ingested: 3, skipped: 0, errors: 0 });
    await runCommand();
    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("3");
  });

  it("does not log auto-ingest message when no new sessions found", async () => {
    vi.mocked(runIngest).mockReturnValue({ ingested: 0, skipped: 5, errors: 0 });
    await runCommand();
    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).not.toContain("Auto-ingested");
  });

  it("calls onboardCommand and returns early when lastCycleDate is null", async () => {
    vi.mocked(getLatestCycleDate).mockReturnValue(null);
    await runCommand();
    expect(onboardCommand).toHaveBeenCalledOnce();
    expect(callClaudeForJson).not.toHaveBeenCalled();
  });

  it("calls onboardCommand and returns early when --onboard flag is set", async () => {
    await runCommand({ onboard: true });
    expect(onboardCommand).toHaveBeenCalledOnce();
    expect(callClaudeForJson).not.toHaveBeenCalled();
  });

  it("exits with code 1 when no sessions are found after ingest", async () => {
    vi.mocked(readAllSessions).mockReturnValue([]);
    await expect(runCommand()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(callClaudeForJson).not.toHaveBeenCalled();
  });

  it("calls callClaudeForJson with a prompt string", async () => {
    await runCommand();
    expect(callClaudeForJson).toHaveBeenCalledOnce();
    const promptArg = vi.mocked(callClaudeForJson).mock.calls[0][0] as string;
    expect(typeof promptArg).toBe("string");
    expect(promptArg.length).toBeGreaterThan(100);
  });

  it("writes the cycle file after successful Claude invocation", async () => {
    await runCommand();
    expect(writeCycleFile).toHaveBeenCalledOnce();
    const [date, content] = vi.mocked(writeCycleFile).mock.calls[0];
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(content).toContain("# Retro Cycle");
  });

  it("writes a pending diff after successful Claude invocation", async () => {
    await runCommand();
    expect(writePendingDiff).toHaveBeenCalledOnce();
    const [pendingDiff] = vi.mocked(writePendingDiff).mock.calls[0];
    expect(pendingDiff.section).toBe(MOCK_SYNTHESIS.proposed_instruction.section);
    expect(pendingDiff.rationale).toBe(MOCK_SYNTHESIS.proposed_instruction.rationale);
    expect(pendingDiff.diff).toBe(MOCK_SYNTHESIS.proposed_instruction.diff);
  });

  it("pending diff includes the opportunity field", async () => {
    await runCommand();
    const [pendingDiff] = vi.mocked(writePendingDiff).mock.calls[0];
    expect(pendingDiff.opportunity).toEqual(MOCK_SYNTHESIS.opportunity);
  });

  it("pending diff timestamp is an ISO-8601 string", async () => {
    await runCommand();
    const [pendingDiff] = vi.mocked(writePendingDiff).mock.calls[0];
    expect(() => new Date(pendingDiff.timestamp).toISOString()).not.toThrow();
  });

  it("starts and stops the spinner around the Claude call", async () => {
    await runCommand();
    expect(startSpinner).toHaveBeenCalledOnce();
    expect(mockStopSpinner).toHaveBeenCalledOnce();
  });

  it("stops the spinner and exits with code 1 when Claude call fails", async () => {
    vi.mocked(callClaudeForJson).mockRejectedValue(new Error("Claude CLI error"));
    await expect(runCommand()).rejects.toThrow("process.exit(1)");
    expect(mockStopSpinner).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("logs the Claude error message on failure", async () => {
    vi.mocked(callClaudeForJson).mockRejectedValue(new Error("timeout reached"));
    await expect(runCommand()).rejects.toThrow("process.exit(1)");
    const errorCalls = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(errorCalls).toContain("timeout reached");
  });

  it("does not write cycle file or pending diff when Claude call fails", async () => {
    vi.mocked(callClaudeForJson).mockRejectedValue(new Error("fail"));
    await expect(runCommand()).rejects.toThrow("process.exit(1)");
    expect(writeCycleFile).not.toHaveBeenCalled();
    expect(writePendingDiff).not.toHaveBeenCalled();
  });

  it("loads captures since the last cycle date", async () => {
    await runCommand();
    expect(readCaptures).toHaveBeenCalledWith(expect.any(String), "2025-01-01");
  });

  it("loads reflections since the last cycle date", async () => {
    await runCommand();
    expect(readReflections).toHaveBeenCalledWith(expect.any(String), "2025-01-01");
  });

  it("includes captures count in output when captures are present", async () => {
    const captures: Capture[] = [
      { id: "c1", text: "Notable", author: "Leo", timestamp: "2025-01-10T00:00:00Z" },
    ];
    vi.mocked(readCaptures).mockReturnValue(captures);
    await runCommand();
    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("1");
  });

  it("logs reflection count and authors when reflections are found", async () => {
    vi.mocked(readReflections).mockReturnValue([
      makeReflection({ author: "Alice" }),
      makeReflection({ id: "r2", author: "Bob", timestamp: "2025-01-16T00:00:00Z" }),
    ]);
    await runCommand();
    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("Alice");
    expect(consoleCalls).toContain("Bob");
  });

  it("logs a nudge when no reflections are found", async () => {
    vi.mocked(readReflections).mockReturnValue([]);
    await runCommand();
    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("patina reflect");
  });

  it("uses allSessions in the cycle when cycleSessions is empty", async () => {
    // Sessions are all older than lastCycleDate so cycleSessions will be empty
    vi.mocked(getLatestCycleDate).mockReturnValue("2025-06-01");
    vi.mocked(readAllSessions).mockReturnValue([
      makeSession({ timestamp: "2025-01-01T00:00:00Z" }),
    ]);
    await runCommand();
    // Claude should still be called (fallback to allSessions)
    expect(callClaudeForJson).toHaveBeenCalledOnce();
  });

  it("calls assertInitialised at the start", async () => {
    await runCommand();
    expect(assertInitialised).toHaveBeenCalledOnce();
  });

  it("logs the cycle file path in the saved footer", async () => {
    await runCommand();
    const today = new Date().toISOString().slice(0, 10);
    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain(`${today}.md`);
  });

  it("suggests patina buff in the footer output", async () => {
    await runCommand();
    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("patina buff");
  });

  it("logs 'No patterns identified' when synthesis returns empty patterns", async () => {
    const synthesisNoPatterns: SynthesisResponse = {
      ...MOCK_SYNTHESIS,
      patterns: [],
    };
    vi.mocked(callClaudeForJson).mockResolvedValue(synthesisNoPatterns);
    await runCommand();
    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("No patterns identified");
  });

  it("loads living doc with spoke files when they are present", async () => {
    vi.mocked(loadSpokeFiles).mockReturnValue("## 4. Autonomy Detail\n\nSome spoke content.");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      "# AI Operating Constitution\n\n## 1. Working Agreements\n",
    );
    await runCommand();
    // Claude should receive a prompt containing spoke content
    const promptArg = vi.mocked(callClaudeForJson).mock.calls[0][0] as string;
    expect(promptArg).toContain("AI Operating Constitution");
  });

  it("handles non-Error Claude failures gracefully", async () => {
    vi.mocked(callClaudeForJson).mockRejectedValue("plain string error");
    await expect(runCommand()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
    const errorCalls = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(errorCalls).toContain("plain string error");
  });
});
