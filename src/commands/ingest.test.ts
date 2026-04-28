import { describe, it, expect, vi, beforeEach } from "vitest";

let nextReadlineAnswer = "n";

vi.mock("readline", () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: vi.fn((_q: string, cb: (a: string) => void) => cb(nextReadlineAnswer)),
      close: vi.fn(),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Mock external dependencies before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("../lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage.js")>();
  return {
    ...actual,
    assertInitialised: vi.fn(),
    sessionExists: vi.fn(),
    writeSession: vi.fn(),
    readConfig: vi.fn(),
    readCaptures: vi.fn(),
    getLatestCycleDate: vi.fn(),
    getDataDir: vi.fn(() => "/fake/data-dir"),
  };
});

vi.mock("../lib/data-dir-git.js", () => ({
  shouldSync: vi.fn(() => false),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
}));

vi.mock("../lib/parser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/parser.js")>();
  return {
    ...actual,
    discoverProjects: vi.fn(),
    parseConversationFile: vi.fn(),
    cwdToSlug: vi.fn(),
  };
});

vi.mock("../lib/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/git.js")>();
  return { ...actual, getGitAuthor: vi.fn() };
});

vi.mock("./capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capture.js")>();
  return { ...actual, captureCommand: vi.fn() };
});

vi.mock("../lib/capture-triggers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/capture-triggers.js")>();
  return {
    ...actual,
    suggestCaptureFromSessions: vi.fn(actual.suggestCaptureFromSessions),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { runIngest, ingestCommand } from "./ingest.js";
import * as ingestModule from "./ingest.js";
import {
  assertInitialised,
  sessionExists,
  writeSession,
  readConfig,
  readCaptures,
  getLatestCycleDate,
  getDataDir,
} from "../lib/storage.js";
import { discoverProjects, parseConversationFile, cwdToSlug } from "../lib/parser.js";
import { getGitAuthor } from "../lib/git.js";
import type { SessionSummary } from "../lib/storage.js";
import { shouldSync, gitPush } from "../lib/data-dir-git.js";
import { captureCommand } from "./capture.js";
import { suggestCaptureFromSessions } from "../lib/capture-triggers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParsedSession(
  overrides: Partial<SessionSummary> = {},
): Omit<SessionSummary, "ingested_at" | "author" | "projectAlias"> {
  return {
    session_id: "session-abc",
    project: "test-project",
    timestamp: "2025-01-15T10:00:00Z",
    turn_count: 5,
    estimated_tokens: 2000,
    tool_calls: { Read: 3 },
    had_rework: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readConfig).mockReturnValue({ include: [], exclude: [] });
  vi.mocked(cwdToSlug).mockReturnValue("-Users-test-project");
  vi.mocked(getGitAuthor).mockReturnValue("Leo");
  vi.mocked(assertInitialised).mockReturnValue(undefined);
  vi.mocked(writeSession).mockReturnValue(undefined);
  vi.mocked(readCaptures).mockReturnValue([]);
  vi.mocked(getLatestCycleDate).mockReturnValue(null);
  nextReadlineAnswer = "n";
});

// ---------------------------------------------------------------------------
// runIngest
// ---------------------------------------------------------------------------

describe("runIngest", () => {
  it("returns zero counts when no projects are discovered", () => {
    vi.mocked(discoverProjects).mockReturnValue([]);
    const result = runIngest();
    expect(result).toEqual({ ingested: 0, skipped: 0, errors: 0 });
  });

  it("ingests a new session and returns ingested count of 1", () => {
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "test-project", conversationFile: "/fake/path.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(false);

    const result = runIngest();

    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("skips sessions that already exist on disk", () => {
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "test-project", conversationFile: "/fake/path.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(true);

    const result = runIngest();

    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("increments errors when parseConversationFile throws", () => {
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "bad-project", conversationFile: "/bad/path.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockImplementation(() => {
      throw new Error("ENOENT: file not found");
    });

    const result = runIngest();

    expect(result.errors).toBe(1);
    expect(result.ingested).toBe(0);
  });

  it("increments errors when writeSession throws", () => {
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(false);
    vi.mocked(writeSession).mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = runIngest();

    expect(result.errors).toBe(1);
    expect(result.ingested).toBe(0);
  });

  it("handles multiple sessions from one project file", () => {
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([
      makeParsedSession({ session_id: "s1" }),
      makeParsedSession({ session_id: "s2" }),
      makeParsedSession({ session_id: "s3" }),
    ]);
    vi.mocked(sessionExists).mockReturnValue(false);

    const result = runIngest();

    expect(result.ingested).toBe(3);
    expect(vi.mocked(writeSession)).toHaveBeenCalledTimes(3);
  });

  it("mixes ingested, skipped, and errored sessions in one pass", () => {
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj-a", conversationFile: "/a.jsonl" },
      { name: "proj-b", conversationFile: "/b.jsonl" },
    ]);

    vi.mocked(parseConversationFile)
      .mockReturnValueOnce([
        makeParsedSession({ session_id: "new-1" }),
        makeParsedSession({ session_id: "dup-1" }),
      ])
      .mockImplementationOnce(() => {
        throw new Error("parse failure");
      });

    vi.mocked(sessionExists).mockImplementation((id: string) => id === "dup-1");

    const result = runIngest();

    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("passes includeSlugs and excludeSlugs from config to discoverProjects", () => {
    vi.mocked(readConfig).mockReturnValue({ include: ["extra-project"], exclude: ["excluded"] });
    vi.mocked(discoverProjects).mockReturnValue([]);

    runIngest();

    expect(vi.mocked(discoverProjects)).toHaveBeenCalledWith(
      undefined,
      expect.arrayContaining(["extra-project"]),
      expect.arrayContaining(["excluded"]),
    );
  });

  it("uses the custom claudeDir when provided", () => {
    vi.mocked(discoverProjects).mockReturnValue([]);

    runIngest({ claudeDir: "/custom/claude/dir" });

    expect(vi.mocked(discoverProjects)).toHaveBeenCalledWith(
      "/custom/claude/dir",
      expect.any(Array),
      expect.any(Array),
    );
  });

  it("calls writeSession with ingested_at and author metadata", () => {
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(false);
    vi.mocked(getGitAuthor).mockReturnValue("Test Author");

    runIngest();

    const callArgs = vi.mocked(writeSession).mock.calls[0][0] as SessionSummary;
    expect(callArgs.ingested_at).toBeTruthy();
    expect(callArgs.author).toBe("Test Author");
    expect(callArgs.projectAlias).toBeTruthy();
  });

  it("logs verbose output when verbose option is true", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(false);

    runIngest({ verbose: true });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("does not log when verbose is false", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([]);

    runIngest({ verbose: false });

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// ingestCommand
// ---------------------------------------------------------------------------

describe("ingestCommand", () => {
  it("calls assertInitialised before doing anything else", async () => {
    vi.mocked(discoverProjects).mockReturnValue([]);
    await ingestCommand();
    expect(vi.mocked(assertInitialised)).toHaveBeenCalledOnce();
  });

  it("logs a message when no projects are found", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([]);

    await ingestCommand();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No Claude Code project logs"));
    consoleSpy.mockRestore();
  });

  it("returns without ingesting when projects list is empty", async () => {
    vi.mocked(discoverProjects).mockReturnValue([]);
    await ingestCommand();
    expect(vi.mocked(writeSession)).not.toHaveBeenCalled();
  });

  it("ingests a new session and prints a done summary", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(false);

    await ingestCommand();

    expect(vi.mocked(writeSession)).toHaveBeenCalledOnce();
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("Done.");
    expect(allLogs).toContain("1 session(s) ingested");
    consoleSpy.mockRestore();
  });

  it("skips duplicate sessions and reports them in the summary", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(true);

    await ingestCommand();

    expect(vi.mocked(writeSession)).not.toHaveBeenCalled();
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("1 skipped");
    consoleSpy.mockRestore();
  });

  it("reports parse errors in the summary when they occur", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([{ name: "bad", conversationFile: "/bad.jsonl" }]);
    vi.mocked(parseConversationFile).mockImplementation(() => {
      throw new Error("parse error");
    });

    await ingestCommand();

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("1 error(s)");
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("does not print the status prompt when nothing was ingested", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(true); // all skipped

    await ingestCommand();

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).not.toContain("patina status");
    consoleSpy.mockRestore();
  });

  it("prints the status prompt when sessions were ingested", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(false);

    await ingestCommand();

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("patina status");
    consoleSpy.mockRestore();
  });

  it("uses custom claudeDir when passed as option", async () => {
    vi.mocked(discoverProjects).mockReturnValue([]);

    await ingestCommand({ claudeDir: "/custom/dir" });

    expect(vi.mocked(discoverProjects)).toHaveBeenCalledWith(
      "/custom/dir",
      expect.any(Array),
      expect.any(Array),
    );
  });

  it("prints verbose file-by-file output when verbose is true", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(false);

    await ingestCommand({ verbose: true });

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("/fake.jsonl");
    consoleSpy.mockRestore();
  });

  it("prints a capture suggestion prompt (declined)", async () => {
    const interactiveSpy = vi.spyOn(ingestModule.terminal, "isInteractive").mockReturnValue(true);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([
      makeParsedSession({ timestamp: new Date().toISOString() }),
    ]);
    vi.mocked(sessionExists).mockReturnValue(false);
    vi.mocked(suggestCaptureFromSessions).mockReturnValue({
      tag: "frustration",
      reason: "Rework detected in a newly ingested session.",
    });
    nextReadlineAnswer = "n";

    try {
      await ingestCommand();

      const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(allLogs).toContain("Capture suggestion:");
      expect(vi.mocked(captureCommand)).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
      interactiveSpy.mockRestore();
    }
  });

  it("runs capture when the suggestion prompt is accepted", async () => {
    const interactiveSpy = vi.spyOn(ingestModule.terminal, "isInteractive").mockReturnValue(true);

    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([
      makeParsedSession({ timestamp: new Date().toISOString() }),
    ]);
    vi.mocked(sessionExists).mockReturnValue(false);
    vi.mocked(suggestCaptureFromSessions).mockReturnValue({
      tag: "frustration",
      reason: "Rework detected in a newly ingested session.",
    });
    nextReadlineAnswer = "y";

    try {
      await ingestCommand();

      expect(vi.mocked(captureCommand)).toHaveBeenCalledWith(undefined, { tag: "frustration" });
    } finally {
      interactiveSpy.mockRestore();
    }
  });

  it("calls gitPush when sessions were ingested and shouldSync is true", async () => {
    vi.mocked(shouldSync).mockReturnValue(true);
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(false);

    await ingestCommand();

    expect(vi.mocked(gitPush)).toHaveBeenCalledWith(
      "/fake/data-dir",
      expect.stringContaining("ingest:"),
    );
  });

  it("does not call gitPush when nothing was ingested", async () => {
    vi.mocked(shouldSync).mockReturnValue(true);
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([makeParsedSession()]);
    vi.mocked(sessionExists).mockReturnValue(true); // all skipped

    await ingestCommand();

    expect(vi.mocked(gitPush)).not.toHaveBeenCalled();
  });

  it("logs verbose skip message when skipping a duplicate in ingestCommand", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([
      makeParsedSession({ session_id: "dup-session" }),
    ]);
    vi.mocked(sessionExists).mockReturnValue(true);

    await ingestCommand({ verbose: true });

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("dup-session");
    consoleSpy.mockRestore();
  });

  it("logs verbose ingest message when writing a new session in ingestCommand", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([
      makeParsedSession({ session_id: "new-session", turn_count: 7 }),
    ]);
    vi.mocked(sessionExists).mockReturnValue(false);

    await ingestCommand({ verbose: true });

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("new-session");
    consoleSpy.mockRestore();
  });

  it("logs warn and counts error when writeSession throws in ingestCommand", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(discoverProjects).mockReturnValue([
      { name: "proj", conversationFile: "/fake.jsonl" },
    ]);
    vi.mocked(parseConversationFile).mockReturnValue([
      makeParsedSession({ session_id: "fail-session" }),
    ]);
    vi.mocked(sessionExists).mockReturnValue(false);
    vi.mocked(writeSession).mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await ingestCommand();

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("1 error(s)");
    warnSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
