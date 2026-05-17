import { describe, it, expect, vi } from "vitest";
import { synthesizeCycle, type SynthesisResponse } from "./cycle.js";
import type { SessionSummary, Reflection } from "./storage.js";

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: "test-session",
    project: "test-project",
    timestamp: "2025-01-15T00:00:00Z",
    turn_count: 4,
    estimated_tokens: 1000,
    tool_calls: { Read: 3, Edit: 1 },
    had_rework: false,
    ingested_at: "2025-01-15T00:00:00Z",
    ...overrides,
  };
}

function makeReflection(overrides: Partial<Reflection> = {}): Reflection {
  return {
    id: "r1",
    author: "Leo",
    timestamp: "2025-01-15T10:00:00Z",
    cycleStart: "2025-01-01",
    answers: { overall_feel: "Good" },
    ...overrides,
  };
}

const MOCK_SYNTHESIS: SynthesisResponse = {
  cycle_summary: "Steady cycle with consistent reads.",
  patterns: [
    {
      pattern: "Heavy read usage",
      frequency: "Every session",
      interpretation: "Explores before editing",
    },
  ],
  coaching_insight: {
    observation: "Sessions start with many reads.",
    what_it_suggests: "Targeted reads would help.",
    one_thing_to_try: "Use line ranges.",
  },
  proposed_instruction: {
    rationale: "Reduce tokens.",
    diff: "- Prefer targeted reads",
    section: "1. Working Agreements",
  },
  opportunity: {
    observation: "Manual status checks.",
    suggestion: "Automate.",
    effort: "low",
  },
};

describe("synthesizeCycle", () => {
  const baseInput = {
    today: "2025-01-15",
    cycleStart: "2025-01-01",
    cycleEnd: "2025-01-15",
    lastCycleDate: "2025-01-01" as string | null,
    livingDoc: "# AI Operating Constitution\n",
    capabilitiesSection: null,
    sessions: [makeSession({ estimated_tokens: 2500, had_rework: true })],
    captures: [],
    reflections: [makeReflection()],
    priorCycles: [],
    patinaDocTokens: 99,
  };

  it("returns the synthesis verbatim from callClaude", async () => {
    const callClaude = vi.fn().mockResolvedValue({ synthesis: MOCK_SYNTHESIS, tokens: 555 });
    const result = await synthesizeCycle({ ...baseInput, callClaude });

    expect(result.synthesis).toBe(MOCK_SYNTHESIS);
    expect(result.synthesisTokens).toBe(555);
  });

  it("passes the synthesis prompt to callClaude", async () => {
    const callClaude = vi.fn().mockResolvedValue({ synthesis: MOCK_SYNTHESIS, tokens: 0 });
    await synthesizeCycle({ ...baseInput, callClaude });

    expect(callClaude).toHaveBeenCalledOnce();
    const prompt = callClaude.mock.calls[0][0];
    expect(prompt).toContain("## Cycle Overview");
    expect(prompt).toContain("2025-01-01 → 2025-01-15");
    expect(prompt).toContain("# AI Operating Constitution");
  });

  it("produces a cycle markdown that includes the date and summary", async () => {
    const callClaude = vi.fn().mockResolvedValue({ synthesis: MOCK_SYNTHESIS, tokens: 0 });
    const result = await synthesizeCycle({ ...baseInput, callClaude });

    expect(result.cycleMarkdown).toContain("# Retro Cycle — 2025-01-15");
    expect(result.cycleMarkdown).toContain(MOCK_SYNTHESIS.cycle_summary);
  });

  it("builds a pendingDiff from the proposed instruction and opportunity", async () => {
    const callClaude = vi.fn().mockResolvedValue({ synthesis: MOCK_SYNTHESIS, tokens: 0 });
    const result = await synthesizeCycle({ ...baseInput, callClaude });

    expect(result.pendingDiff).toMatchObject({
      section: "1. Working Agreements",
      rationale: "Reduce tokens.",
      diff: "- Prefer targeted reads",
      opportunity: MOCK_SYNTHESIS.opportunity,
    });
    expect(() => new Date(result.pendingDiff.timestamp).toISOString()).not.toThrow();
  });

  it("builds a nextCycleEntry with aggregates and token costs", async () => {
    const callClaude = vi.fn().mockResolvedValue({ synthesis: MOCK_SYNTHESIS, tokens: 321 });
    const result = await synthesizeCycle({ ...baseInput, callClaude });

    expect(result.nextCycleEntry).toMatchObject({
      cycle_id: "2025-01-15",
      session_count: 1,
      total_tokens: 2500,
      rework_count: 1,
      synthesis_tokens: 321,
      patina_md_tokens: 99,
    });
  });

  it("propagates errors from callClaude", async () => {
    const callClaude = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(synthesizeCycle({ ...baseInput, callClaude })).rejects.toThrow("boom");
  });
});
