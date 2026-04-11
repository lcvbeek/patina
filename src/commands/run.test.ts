import { describe, it, expect } from "vitest";
import {
  compressSessionsForPrompt,
  buildSynthesisPrompt,
  buildCycleMarkdown,
  type SynthesisResponse,
} from "./run.js";
import type { SessionSummary, Capture, Reflection } from "../lib/storage.js";

function makeReflection(
  answers: Record<string, string>,
  overrides: Partial<Reflection> = {},
): Reflection {
  return {
    id: "test-reflection",
    author: "Leo",
    timestamp: "2025-01-14T10:00:00Z",
    cycleStart: "2025-01-01",
    answers,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: "test-session",
    project: "test-project",
    timestamp: "2025-01-15T00:00:00Z",
    turn_count: 4,
    estimated_tokens: 1000,
    tool_calls: {},
    had_rework: false,
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
    { pattern: "Low rework", frequency: "Rarely", interpretation: "Plans well upfront" },
  ],
  coaching_insight: {
    observation: "Sessions tend to start with many reads.",
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
    expect(result).not.toContain("Glob:1"); // 4th tool is excluded
  });

  it('shows "none" when session has no tool calls', () => {
    const result = compressSessionsForPrompt([makeSession({ tool_calls: {} })]);
    expect(result).toContain("none");
  });

  it('shows "yes" in rework column for sessions with rework', () => {
    const result = compressSessionsForPrompt([makeSession({ had_rework: true })]);
    expect(result).toContain("yes");
  });

  it("limits to 30 rows and adds overflow message for 31 sessions", () => {
    const sessions = Array.from({ length: 31 }, (_, i) =>
      makeSession({ session_id: String(i), project: "proj" }),
    );
    const result = compressSessionsForPrompt(sessions);
    expect(result).toContain("… and 1 more sessions");
    // Count data rows (lines with | separators that have a date)
    const dataRows = result.split("\n").filter((l) => /\d{4}-\d{2}-\d{2}/.test(l));
    expect(dataRows.length).toBe(30);
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
    reflections: [makeReflection({ overall_feel: "Good", went_well: "Everything" })],
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

  it('shows "Not enough data" when trend analysis is insufficient', () => {
    // Only 1 session → computeTrend returns null
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
});

// ---------------------------------------------------------------------------
// buildCycleMarkdown
// ---------------------------------------------------------------------------

describe("buildCycleMarkdown", () => {
  const baseParams = {
    date: "2025-01-15",
    cycleStart: "2025-01-01",
    cycleEnd: "2025-01-15",
    reflections: [makeReflection({ overall_feel: "Great cycle" })],
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
    const md = buildCycleMarkdown(baseParams);
    expect(md).toContain("### Pattern 1: Heavy read usage");
    expect(md).toContain("### Pattern 2: Low rework");
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
});
