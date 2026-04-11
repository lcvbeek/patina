import { describe, it, expect } from "vitest";
import {
  computeAggregates,
  computeTrend,
  formatNumber,
  formatDate,
  trendArrow,
} from "./metrics.js";
import type { SessionSummary } from "./storage.js";

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: "test-session",
    project: "test-project",
    timestamp: "2025-01-01T00:00:00Z",
    turn_count: 4,
    estimated_tokens: 1000,
    tool_calls: {},
    had_rework: false,
    ...overrides,
  };
}

describe("formatNumber", () => {
  it("formats zero", () => {
    expect(formatNumber(0)).toBe("0");
  });

  it("formats small number without comma", () => {
    expect(formatNumber(999)).toBe("999");
  });

  it("formats 1000 with comma", () => {
    expect(formatNumber(1000)).toBe("1,000");
  });

  it("formats large number with commas", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });
});

describe("formatDate", () => {
  it("returns a non-empty string for a valid ISO date", () => {
    const result = formatDate("2025-01-15T00:00:00Z");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("returns a string for invalid input (no throw)", () => {
    // new Date('not-a-date') returns Invalid Date without throwing,
    // so toLocaleDateString returns 'Invalid Date' rather than the input.
    const result = formatDate("not-a-date");
    expect(typeof result).toBe("string");
  });
});

describe("trendArrow", () => {
  it("returns empty string for null", () => {
    expect(trendArrow(null)).toBe("");
  });

  it("returns arrow with ▲ for positive delta", () => {
    expect(trendArrow(10)).toContain("▲");
  });

  it("returns arrow with ▼ for negative delta", () => {
    expect(trendArrow(-5)).toContain("▼");
  });

  it("returns steady arrow for zero", () => {
    expect(trendArrow(0)).toBe("→ 0%");
  });
});

describe("computeAggregates", () => {
  it("returns zero-valued struct for empty array", () => {
    const agg = computeAggregates([]);
    expect(agg.total_sessions).toBe(0);
    expect(agg.total_tokens).toBe(0);
    expect(agg.avg_tokens_per_session).toBe(0);
    expect(agg.rework_sessions).toBe(0);
    expect(agg.rework_rate_pct).toBe(0);
    expect(agg.tool_usage).toEqual([]);
    expect(agg.date_range).toBeNull();
  });

  it("aggregates a single session", () => {
    const session = makeSession({ estimated_tokens: 500, had_rework: true });
    const agg = computeAggregates([session]);
    expect(agg.total_sessions).toBe(1);
    expect(agg.total_tokens).toBe(500);
    expect(agg.avg_tokens_per_session).toBe(500);
    expect(agg.rework_sessions).toBe(1);
    expect(agg.rework_rate_pct).toBe(100);
  });

  it("sums tokens and averages correctly across multiple sessions", () => {
    const sessions = [
      makeSession({ estimated_tokens: 1000 }),
      makeSession({ session_id: "b", estimated_tokens: 3000 }),
    ];
    const agg = computeAggregates(sessions);
    expect(agg.total_tokens).toBe(4000);
    expect(agg.avg_tokens_per_session).toBe(2000);
  });

  it("merges and sorts tool usage across sessions", () => {
    const sessions = [
      makeSession({ tool_calls: { Read: 3, Edit: 1 } }),
      makeSession({ session_id: "b", tool_calls: { Read: 2, Bash: 5 } }),
    ];
    const agg = computeAggregates(sessions);
    // Read: 3+2=5, Bash: 5, Edit: 1 — sorted descending by count
    const read = agg.tool_usage.find((t) => t.tool === "Read")!;
    const edit = agg.tool_usage.find((t) => t.tool === "Edit")!;
    const bash = agg.tool_usage.find((t) => t.tool === "Bash")!;
    expect(read.count).toBe(5);
    expect(bash.count).toBe(5);
    expect(edit.count).toBe(1);
    // Edit should be last (lowest count)
    const editIdx = agg.tool_usage.indexOf(edit);
    const readIdx = agg.tool_usage.indexOf(read);
    expect(readIdx).toBeLessThan(editIdx);
  });

  it("counts sessions by project", () => {
    const sessions = [
      makeSession({ project: "alpha" }),
      makeSession({ session_id: "b", project: "beta" }),
      makeSession({ session_id: "c", project: "alpha" }),
    ];
    const agg = computeAggregates(sessions);
    expect(agg.sessions_by_project["alpha"]).toBe(2);
    expect(agg.sessions_by_project["beta"]).toBe(1);
  });

  it("returns min/max date range from timestamps", () => {
    const sessions = [
      makeSession({ timestamp: "2025-06-01T00:00:00Z" }),
      makeSession({ session_id: "b", timestamp: "2025-01-01T00:00:00Z" }),
      makeSession({ session_id: "c", timestamp: "2025-12-01T00:00:00Z" }),
    ];
    const agg = computeAggregates(sessions);
    expect(agg.date_range?.earliest).toContain("2025-01-01");
    expect(agg.date_range?.latest).toContain("2025-12-01");
  });

  it("computes rework rate correctly", () => {
    const sessions = [
      makeSession({ had_rework: true }),
      makeSession({ session_id: "b", had_rework: false }),
      makeSession({ session_id: "c", had_rework: false }),
      makeSession({ session_id: "d", had_rework: false }),
    ];
    const agg = computeAggregates(sessions);
    expect(agg.rework_sessions).toBe(1);
    expect(agg.rework_rate_pct).toBe(25);
  });
});

describe("computeTrend", () => {
  it("returns null for fewer than 4 sessions", () => {
    expect(computeTrend([])).toBeNull();
    expect(computeTrend([makeSession()])).toBeNull();
    expect(computeTrend([makeSession(), makeSession({ session_id: "b" })])).toBeNull();
    expect(
      computeTrend([
        makeSession(),
        makeSession({ session_id: "b" }),
        makeSession({ session_id: "c" }),
      ]),
    ).toBeNull();
  });

  it("sorts by timestamp before splitting", () => {
    // Provide sessions out of order — older ones have higher tokens
    const sessions = [
      makeSession({ session_id: "d", timestamp: "2025-04-01T00:00:00Z", estimated_tokens: 100 }),
      makeSession({ session_id: "a", timestamp: "2025-01-01T00:00:00Z", estimated_tokens: 900 }),
      makeSession({ session_id: "b", timestamp: "2025-02-01T00:00:00Z", estimated_tokens: 900 }),
      makeSession({ session_id: "c", timestamp: "2025-03-01T00:00:00Z", estimated_tokens: 100 }),
    ];
    const trend = computeTrend(sessions)!;
    // Previous half (older): sessions a,b → avg 900. Current half: sessions c,d → avg 100.
    // Token delta should be negative (improvement).
    expect(trend.token_delta_pct).not.toBeNull();
    expect(trend.token_delta_pct!).toBeLessThan(0);
  });

  it("splits 5 sessions with mid=2 (previous gets 2, current gets 3)", () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      makeSession({ session_id: String(i), timestamp: `2025-0${i + 1}-01T00:00:00Z` }),
    );
    // Just verify it returns a result (no crash)
    const trend = computeTrend(sessions);
    expect(trend).not.toBeNull();
  });

  it("returns null token_delta_pct when previous avg is zero", () => {
    const sessions = [
      makeSession({ estimated_tokens: 0 }),
      makeSession({ session_id: "b", estimated_tokens: 0 }),
      makeSession({ session_id: "c", timestamp: "2025-06-01T00:00:00Z", estimated_tokens: 500 }),
      makeSession({ session_id: "d", timestamp: "2025-07-01T00:00:00Z", estimated_tokens: 500 }),
    ];
    const trend = computeTrend(sessions)!;
    expect(trend.token_delta_pct).toBeNull();
  });
});
