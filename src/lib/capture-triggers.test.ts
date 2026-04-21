import { describe, it, expect } from "vitest";
import { suggestCaptureFromSessions } from "./capture-triggers.js";
import type { SessionSummary } from "./storage.js";

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: "s1",
    project: "patina",
    timestamp: "2025-01-15T00:00:00Z",
    turn_count: 4,
    estimated_tokens: 1000,
    tool_calls: {},
    had_rework: false,
    ingested_at: "2025-01-15T00:00:00Z",
    ...overrides,
  };
}

describe("suggestCaptureFromSessions", () => {
  it("returns null for empty array", () => {
    expect(suggestCaptureFromSessions([])).toBeNull();
  });

  it("returns null when no signals are present", () => {
    expect(suggestCaptureFromSessions([makeSession(), makeSession({ session_id: "s2" })])).toBeNull();
  });

  // ── Rework detection ────────────────────────────────────────────────────────

  it("returns frustration tag for 1 rework session", () => {
    const result = suggestCaptureFromSessions([makeSession({ had_rework: true })]);
    expect(result).toEqual({
      tag: "frustration",
      reason: "Rework detected in a newly ingested session.",
    });
  });

  it("returns pattern tag for 2 rework sessions", () => {
    const result = suggestCaptureFromSessions([
      makeSession({ had_rework: true }),
      makeSession({ session_id: "s2", had_rework: true }),
    ]);
    expect(result).toEqual({
      tag: "pattern",
      reason: "Rework detected in 2 newly ingested sessions.",
    });
  });

  it("returns pattern tag with correct count for 3 rework sessions", () => {
    const sessions = [
      makeSession({ had_rework: true }),
      makeSession({ session_id: "s2", had_rework: true }),
      makeSession({ session_id: "s3", had_rework: true }),
    ];
    const result = suggestCaptureFromSessions(sessions);
    expect(result?.tag).toBe("pattern");
    expect(result?.reason).toContain("3");
  });

  it("returns frustration for 1 rework among multiple sessions", () => {
    const result = suggestCaptureFromSessions([
      makeSession({ had_rework: true }),
      makeSession({ session_id: "s2" }),
      makeSession({ session_id: "s3" }),
    ]);
    expect(result?.tag).toBe("frustration");
  });

  // ── Heavy context detection ──────────────────────────────────────────────────

  it("returns pattern for session with systemPromptTokens at threshold", () => {
    const result = suggestCaptureFromSessions([
      makeSession({
        contextSnapshot: { systemPromptTokens: 6000, mcpServers: [], deferredTools: [] },
      }),
    ]);
    expect(result).toEqual({
      tag: "pattern",
      reason: "Heavy session-start context detected in a session.",
    });
  });

  it("returns pattern for session with mcpServers at threshold", () => {
    const result = suggestCaptureFromSessions([
      makeSession({
        contextSnapshot: {
          systemPromptTokens: 0,
          mcpServers: ["a", "b", "c", "d", "e", "f"],
          deferredTools: [],
        },
      }),
    ]);
    expect(result?.tag).toBe("pattern");
    expect(result?.reason).toContain("session");
  });

  it("returns pattern with plural reason for 2 heavy context sessions", () => {
    const snap = { systemPromptTokens: 6000, mcpServers: [], deferredTools: [] };
    const result = suggestCaptureFromSessions([
      makeSession({ contextSnapshot: snap }),
      makeSession({ session_id: "s2", contextSnapshot: snap }),
    ]);
    expect(result?.reason).toContain("2 sessions");
  });

  it("returns null when systemPromptTokens and mcpServers are both below thresholds", () => {
    const result = suggestCaptureFromSessions([
      makeSession({
        contextSnapshot: {
          systemPromptTokens: 5999,
          mcpServers: ["a", "b", "c", "d", "e"],
          deferredTools: [],
        },
      }),
    ]);
    expect(result).toBeNull();
  });

  it("skips heavy context check when no contextSnapshot", () => {
    const result = suggestCaptureFromSessions([makeSession({ contextSnapshot: undefined })]);
    expect(result).toBeNull();
  });

  // ── High token detection ─────────────────────────────────────────────────────

  it("returns pattern for session at high token threshold", () => {
    const result = suggestCaptureFromSessions([makeSession({ estimated_tokens: 8000 })]);
    expect(result).toEqual({
      tag: "pattern",
      reason: "A large session was detected (~8000+ tokens).",
    });
  });

  it("returns pattern with plural reason for 2 high token sessions", () => {
    const result = suggestCaptureFromSessions([
      makeSession({ estimated_tokens: 8000 }),
      makeSession({ session_id: "s2", estimated_tokens: 9000 }),
    ]);
    expect(result?.reason).toContain("2 sessions");
  });

  it("returns null for session just below high token threshold", () => {
    expect(suggestCaptureFromSessions([makeSession({ estimated_tokens: 7999 })])).toBeNull();
  });

  // ── Priority ordering ────────────────────────────────────────────────────────

  it("rework takes priority over heavy context", () => {
    const result = suggestCaptureFromSessions([
      makeSession({
        had_rework: true,
        contextSnapshot: { systemPromptTokens: 6000, mcpServers: [], deferredTools: [] },
      }),
    ]);
    expect(result?.tag).toBe("frustration");
    expect(result?.reason).toContain("Rework");
  });

  it("heavy context takes priority over high tokens", () => {
    const result = suggestCaptureFromSessions([
      makeSession({
        estimated_tokens: 8000,
        contextSnapshot: { systemPromptTokens: 6000, mcpServers: [], deferredTools: [] },
      }),
    ]);
    expect(result?.reason).toContain("Heavy session-start context");
  });
});
