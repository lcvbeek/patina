import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateId, buildSynthesisPrompt, resolveTag } from "./capture.js";
import type { Capture } from "../lib/storage.js";

// ---------------------------------------------------------------------------
// Mock external dependencies before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("../lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage.js")>();
  return {
    ...actual,
    assertInitialised: vi.fn(),
    writeCapture: vi.fn(),
    readCaptures: vi.fn(),
    readAllSessions: vi.fn(),
    writePendingDiff: vi.fn(),
    readConfig: vi.fn(),
    getSessionsInCycle: vi.fn(),
    getLatestCycleDate: vi.fn(),
  };
});

vi.mock("../lib/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/git.js")>();
  return { ...actual, getGitAuthor: vi.fn() };
});

vi.mock("../lib/data-dir-git.js", () => ({
  shouldSync: vi.fn(() => false),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
}));

vi.mock("../lib/claude.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/claude.js")>();
  return { ...actual, callClaudeForJson: vi.fn() };
});

vi.mock("../lib/ui.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ui.js")>();
  return { ...actual, startSpinner: vi.fn(() => vi.fn()) };
});

vi.mock("./apply.js", () => ({
  applyCommand: vi.fn(),
}));

vi.mock("../lib/metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/metrics.js")>();
  return {
    ...actual,
    computeAggregates: vi.fn(),
    formatNumber: vi.fn(),
  };
});

// Mock fs for synthesis path (living doc read)
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { captureCommand } from "./capture.js";
import {
  assertInitialised,
  writeCapture,
  readCaptures,
  readAllSessions,
  writePendingDiff,
  readConfig,
  getSessionsInCycle,
  getLatestCycleDate,
  CAPTURE_TAGS,
} from "../lib/storage.js";
import { getGitAuthor } from "../lib/git.js";
import { callClaudeForJson } from "../lib/claude.js";
import { computeAggregates, formatNumber } from "../lib/metrics.js";
import { applyCommand } from "./apply.js";
import fs from "fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapture(overrides: Partial<Capture> = {}): Capture {
  return {
    id: "test-id",
    text: "something notable happened",
    author: "Leo",
    timestamp: "2025-04-09T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertInitialised).mockReturnValue(undefined);
  vi.mocked(writeCapture).mockReturnValue(undefined);
  vi.mocked(readCaptures).mockReturnValue([]);
  vi.mocked(readAllSessions).mockReturnValue([]);
  vi.mocked(writePendingDiff).mockReturnValue(undefined);
  vi.mocked(readConfig).mockReturnValue({ retroReminderAfterSessions: 10, include: [] });
  vi.mocked(getSessionsInCycle).mockReturnValue({ count: 0, lastCycleDate: null });
  vi.mocked(getLatestCycleDate).mockReturnValue(null);
  vi.mocked(getGitAuthor).mockReturnValue("Leo");
  vi.mocked(computeAggregates).mockReturnValue({
    total_sessions: 5,
    avg_tokens_per_session: 1000,
    rework_rate_pct: 10,
    total_tokens: 10000,
    rework_sessions: 2,
    tool_usage: [{ tool: "read", count: 1 }],
    sessions_by_project: {},
    date_range: null,
  });
  vi.mocked(formatNumber).mockImplementation((n: number) => String(n));
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockReturnValue("# PATINA.md content");
});

// ---------------------------------------------------------------------------
// generateId
// ---------------------------------------------------------------------------

describe("generateId", () => {
  it("returns a non-empty string", () => {
    expect(generateId(new Date())).toBeTruthy();
  });

  it("contains the date portion of the input", () => {
    const date = new Date("2025-06-15T10:30:00.000Z");
    const id = generateId(date);
    expect(id).toContain("2025-06-15");
  });

  it("ends with a 4-character random suffix", () => {
    const id = generateId(new Date("2025-01-01T00:00:00.000Z"));
    const parts = id.split("-");
    const suffix = parts[parts.length - 1];
    expect(suffix.length).toBe(4);
  });

  it("matches the expected format", () => {
    const id = generateId(new Date("2025-01-01T00:00:00.000Z"));
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{4}$/);
  });

  it("produces different suffixes across calls (probabilistic)", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const ids = new Set(Array.from({ length: 10 }, () => generateId(now)));
    expect(ids.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// resolveTag
// ---------------------------------------------------------------------------

describe("resolveTag", () => {
  it("resolves a full valid tag name", () => {
    expect(resolveTag("near-miss")).toBe("near-miss");
  });

  it("resolves all valid full tag names", () => {
    for (const tag of CAPTURE_TAGS) {
      expect(resolveTag(tag)).toBe(tag);
    }
  });

  it("resolves shorthand 'n' to near-miss", () => {
    expect(resolveTag("n")).toBe("near-miss");
  });

  it("resolves shorthand 'w' to went-well", () => {
    expect(resolveTag("w")).toBe("went-well");
  });

  it("resolves shorthand 'f' to frustration", () => {
    expect(resolveTag("f")).toBe("frustration");
  });

  it("resolves shorthand 'p' to pattern", () => {
    expect(resolveTag("p")).toBe("pattern");
  });

  it("resolves shorthand 'o' to other", () => {
    expect(resolveTag("o")).toBe("other");
  });

  it("is case-insensitive for shorthands", () => {
    expect(resolveTag("N")).toBe("near-miss");
    expect(resolveTag("W")).toBe("went-well");
  });

  it("is case-insensitive for full tag names", () => {
    expect(resolveTag("NEAR-MISS")).toBe("near-miss");
  });

  it("returns undefined for an unknown tag", () => {
    expect(resolveTag("invalid-tag")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(resolveTag("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildSynthesisPrompt
// ---------------------------------------------------------------------------

describe("buildSynthesisPrompt", () => {
  it("includes the captured text", () => {
    const prompt = buildSynthesisPrompt(makeCapture(), [], "(no PATINA.md)", "Sessions: 5");
    expect(prompt).toContain("something notable happened");
  });

  it("includes the tag when present", () => {
    const prompt = buildSynthesisPrompt(
      makeCapture({ tag: "near-miss" }),
      [],
      "(no PATINA.md)",
      "Sessions: 5",
    );
    expect(prompt).toContain("[near-miss]");
  });

  it("does not include a tag label when tag is absent", () => {
    const prompt = buildSynthesisPrompt(makeCapture({ tag: undefined }), [], "", "");
    const captureSection = prompt.slice(prompt.indexOf("## Just captured"));
    expect(captureSection.split("\n")[0]).not.toContain("[");
  });

  it("includes recent captures", () => {
    const recent = [makeCapture({ id: "other", text: "earlier moment", tag: "went-well" })];
    const prompt = buildSynthesisPrompt(makeCapture(), recent, "(no PATINA.md)", "Sessions: 5");
    expect(prompt).toContain("earlier moment");
    expect(prompt).toContain("[went-well]");
  });

  it("shows placeholder when no prior captures", () => {
    const prompt = buildSynthesisPrompt(makeCapture(), [], "(no PATINA.md)", "Sessions: 5");
    expect(prompt).toContain("no other captures this cycle");
  });

  it("includes the living doc", () => {
    const prompt = buildSynthesisPrompt(makeCapture(), [], "## Working Agreements\n- Do X", "");
    expect(prompt).toContain("Working Agreements");
  });

  it("includes metrics summary", () => {
    const prompt = buildSynthesisPrompt(makeCapture(), [], "", "Avg tokens: 5,000, Rework: 20%");
    expect(prompt).toContain("Avg tokens: 5,000");
  });

  it("includes date prefix for recent captures without a tag", () => {
    const recent = [makeCapture({ id: "no-tag", text: "untagged moment", tag: undefined })];
    const prompt = buildSynthesisPrompt(makeCapture(), recent, "", "");
    expect(prompt).toContain("untagged moment");
    // Should not have a [tag] after the date
    const line = prompt.split("\n").find((l) => l.includes("untagged moment"))!;
    expect(line).not.toMatch(/\[.*\]/);
  });

  it("instructs Claude to respond with raw JSON", () => {
    const prompt = buildSynthesisPrompt(makeCapture(), [], "", "");
    expect(prompt).toContain("raw JSON only");
  });

  it("requests insight and proposed_instruction fields", () => {
    const prompt = buildSynthesisPrompt(makeCapture(), [], "", "");
    expect(prompt).toContain('"insight"');
    expect(prompt).toContain('"proposed_instruction"');
  });
});

// ---------------------------------------------------------------------------
// captureCommand — inline text path (non-interactive)
// ---------------------------------------------------------------------------

describe("captureCommand", () => {
  it("calls assertInitialised on every invocation", async () => {
    await captureCommand("test event", {});
    expect(vi.mocked(assertInitialised)).toHaveBeenCalledOnce();
  });

  it("writes a capture to disk", async () => {
    await captureCommand("agent produced bad output", {});
    expect(vi.mocked(writeCapture)).toHaveBeenCalledOnce();
  });

  it("capture written to disk contains the provided text", async () => {
    await captureCommand("something happened here", {});
    const written = vi.mocked(writeCapture).mock.calls[0][0] as Capture;
    expect(written.text).toBe("something happened here");
  });

  it("capture has a non-empty id", async () => {
    await captureCommand("event", {});
    const written = vi.mocked(writeCapture).mock.calls[0][0] as Capture;
    expect(written.id).toBeTruthy();
  });

  it("capture has an ISO timestamp", async () => {
    await captureCommand("event", {});
    const written = vi.mocked(writeCapture).mock.calls[0][0] as Capture;
    expect(written.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("capture includes the author from getGitAuthor", async () => {
    vi.mocked(getGitAuthor).mockReturnValue("Alice");
    await captureCommand("event", {});
    const written = vi.mocked(writeCapture).mock.calls[0][0] as Capture;
    expect(written.author).toBe("Alice");
  });

  it("capture tag is undefined when --tag is not provided", async () => {
    await captureCommand("event", {});
    const written = vi.mocked(writeCapture).mock.calls[0][0] as Capture;
    expect(written.tag).toBeUndefined();
  });

  it("resolves a full tag name and stores it on the capture", async () => {
    await captureCommand("event", { tag: "went-well" });
    const written = vi.mocked(writeCapture).mock.calls[0][0] as Capture;
    expect(written.tag).toBe("went-well");
  });

  it("resolves a shorthand tag and stores the full tag on the capture", async () => {
    await captureCommand("event", { tag: "n" });
    const written = vi.mocked(writeCapture).mock.calls[0][0] as Capture;
    expect(written.tag).toBe("near-miss");
  });

  it("calls process.exit(1) for an invalid tag", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await captureCommand("event", { tag: "bogus-tag" });

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("error message for invalid tag lists valid tags", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await captureCommand("event", { tag: "bad" });

    const errorMsg = errorSpy.mock.calls[0][0] as string;
    expect(errorMsg).toContain("near-miss");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs a success message after capturing", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await captureCommand("the event text", {});
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("the event text");
    consoleSpy.mockRestore();
  });

  it("logs the author in the capture confirmation line", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(getGitAuthor).mockReturnValue("Bob");
    await captureCommand("event", {});
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("Bob");
    consoleSpy.mockRestore();
  });

  it("does not call synthesiseCapture when --synth is not set", async () => {
    await captureCommand("event", {});
    expect(vi.mocked(callClaudeForJson)).not.toHaveBeenCalled();
  });

  it("does not write a pending diff when --synth is not set", async () => {
    await captureCommand("event", {});
    expect(vi.mocked(writePendingDiff)).not.toHaveBeenCalled();
  });

  it("logs 'patina run' hint when synth is false", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await captureCommand("event", { synth: false });
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("patina run");
    consoleSpy.mockRestore();
  });

  it("shows session reminder tip when session count exceeds threshold", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(readConfig).mockReturnValue({ retroReminderAfterSessions: 5, include: [] });
    vi.mocked(getSessionsInCycle).mockReturnValue({ count: 5, lastCycleDate: null });

    await captureCommand("event", {});

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("patina reflect");
    consoleSpy.mockRestore();
  });

  it("does not show session reminder tip when count is below threshold", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(readConfig).mockReturnValue({ retroReminderAfterSessions: 10, include: [] });
    vi.mocked(getSessionsInCycle).mockReturnValue({ count: 3, lastCycleDate: null });

    await captureCommand("event", {});

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).not.toContain("patina reflect");
    consoleSpy.mockRestore();
  });

  it("does not show reminder when threshold is 0 (disabled)", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(readConfig).mockReturnValue({ retroReminderAfterSessions: 0, include: [] });
    vi.mocked(getSessionsInCycle).mockReturnValue({ count: 100, lastCycleDate: null });

    await captureCommand("event", {});

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).not.toContain("patina reflect");
    consoleSpy.mockRestore();
  });

  it("writeCapture error propagates as thrown exception", async () => {
    vi.mocked(writeCapture).mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(captureCommand("event", {})).rejects.toThrow("disk full");
  });
});

// ---------------------------------------------------------------------------
// captureCommand — synthesis path (--synth flag)
// ---------------------------------------------------------------------------

describe("captureCommand with --synth flag", () => {
  const synthResponse = {
    insight: "This is a pattern about X. It relates to Y. Metrics show Z. Try: doing W.",
    proposed_instruction: {
      section: "1. Working Agreements",
      rationale: "Needed because of capture",
      diff: "- Always confirm before executing",
      action: "add",
    },
  };

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("# PATINA.md\n\n## 1. Working Agreements\n");
    vi.mocked(callClaudeForJson).mockResolvedValue(synthResponse);
  });

  it("calls Claude when --synth is set", async () => {
    await captureCommand("important event", { synth: true });
    expect(vi.mocked(callClaudeForJson)).toHaveBeenCalledOnce();
  });

  it("writes a pending diff after successful synthesis", async () => {
    await captureCommand("important event", { synth: true });
    expect(vi.mocked(writePendingDiff)).toHaveBeenCalledOnce();
  });

  it("pending diff contains the correct section", async () => {
    await captureCommand("important event", { synth: true });
    const diff = vi.mocked(writePendingDiff).mock.calls[0][0];
    expect(diff.section).toBe("1. Working Agreements");
  });

  it("pending diff contains the diff text", async () => {
    await captureCommand("important event", { synth: true });
    const diff = vi.mocked(writePendingDiff).mock.calls[0][0];
    expect(diff.diff).toBe("- Always confirm before executing");
  });

  it("pending diff has an ISO timestamp", async () => {
    await captureCommand("important event", { synth: true });
    const diff = vi.mocked(writePendingDiff).mock.calls[0][0];
    expect(diff.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("logs the insight text to console", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await captureCommand("important event", { synth: true });
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("This is a pattern about X");
    consoleSpy.mockRestore();
  });

  it("calls applyCommand with yes:true after synthesis", async () => {
    await captureCommand("important event", { synth: true });
    expect(vi.mocked(applyCommand)).toHaveBeenCalledWith({ yes: true });
  });

  it("reads PATINA.md for living doc context", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    await captureCommand("important event", { synth: true });
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalled();
  });

  it("uses '(no PATINA.md found)' when living doc does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await captureCommand("important event", { synth: true });
    // Claude is still called (synthesis proceeds without living doc)
    expect(vi.mocked(callClaudeForJson)).toHaveBeenCalledOnce();
    const prompt = vi.mocked(callClaudeForJson).mock.calls[0][0] as string;
    expect(prompt).toContain("no PATINA.md found");
  });

  it("logs a warning but does not throw when Claude call fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(callClaudeForJson).mockRejectedValue(new Error("CLI unavailable"));

    await expect(captureCommand("important event", { synth: true })).resolves.not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("synthesis warning message contains the error message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(callClaudeForJson).mockRejectedValue(new Error("CLI unavailable"));

    await captureCommand("important event", { synth: true });

    const msg = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain("CLI unavailable");
    errorSpy.mockRestore();
  });

  it("does not write pending diff when Claude call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(callClaudeForJson).mockRejectedValue(new Error("timeout"));

    await captureCommand("important event", { synth: true });

    expect(vi.mocked(writePendingDiff)).not.toHaveBeenCalled();
  });

  it("includes recent captures (excluding self) in synthesis context", async () => {
    const recentCapture = makeCapture({ id: "prior-id", text: "earlier observation" });
    vi.mocked(readCaptures).mockReturnValue([recentCapture]);

    await captureCommand("new event", { synth: true });

    const prompt = vi.mocked(callClaudeForJson).mock.calls[0][0] as string;
    expect(prompt).toContain("earlier observation");
  });

  it("passes session metrics to the synthesis prompt", async () => {
    vi.mocked(computeAggregates).mockReturnValue({
      total_sessions: 12,
      avg_tokens_per_session: 3500,
      rework_rate_pct: 15,
      total_tokens: 10000,
      rework_sessions: 2,
      tool_usage: [{ tool: "read", count: 1 }],
      sessions_by_project: {},
      date_range: null,
    });
    vi.mocked(formatNumber).mockReturnValue("3,500");

    await captureCommand("event", { synth: true });

    const prompt = vi.mocked(callClaudeForJson).mock.calls[0][0] as string;
    expect(prompt).toContain("Sessions: 12");
  });
});
