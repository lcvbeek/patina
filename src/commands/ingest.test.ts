import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

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
  };
});

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

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { runIngest, ingestCommand } from "./ingest.js";
import { assertInitialised, sessionExists, writeSession, readConfig } from "../lib/storage.js";
import { discoverProjects, parseConversationFile, cwdToSlug } from "../lib/parser.js";
import { getGitAuthor } from "../lib/git.js";
import type { SessionSummary } from "../lib/storage.js";

// ---------------------------------------------------------------------------
// Type aliases for mocks
// ---------------------------------------------------------------------------

const mockAssertInitialised = assertInitialised as ReturnType<typeof vi.fn>;
const mockSessionExists = sessionExists as ReturnType<typeof vi.fn>;
const mockWriteSession = writeSession as ReturnType<typeof vi.fn>;
const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockDiscoverProjects = discoverProjects as ReturnType<typeof vi.fn>;
const mockParseConversationFile = parseConversationFile as ReturnType<typeof vi.fn>;
const mockCwdToSlug = cwdToSlug as ReturnType<typeof vi.fn>;
const mockGetGitAuthor = getGitAuthor as ReturnType<typeof vi.fn>;

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
  mockReadConfig.mockReturnValue({ include: [], exclude: [] });
  mockCwdToSlug.mockReturnValue("-Users-test-project");
  mockGetGitAuthor.mockReturnValue("Leo");
  mockAssertInitialised.mockReturnValue(undefined);
  mockWriteSession.mockReturnValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// runIngest
// ---------------------------------------------------------------------------

describe("runIngest", () => {
  it("returns zero counts when no projects are discovered", () => {
    mockDiscoverProjects.mockReturnValue([]);
    const result = runIngest();
    expect(result).toEqual({ ingested: 0, skipped: 0, errors: 0 });
  });

  it("ingests a new session and returns ingested count of 1", () => {
    mockDiscoverProjects.mockReturnValue([
      { name: "test-project", conversationFile: "/fake/path.jsonl" },
    ]);
    mockParseConversationFile.mockReturnValue([makeParsedSession()]);
    mockSessionExists.mockReturnValue(false);

    const result = runIngest();

    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("skips sessions that already exist on disk", () => {
    mockDiscoverProjects.mockReturnValue([
      { name: "test-project", conversationFile: "/fake/path.jsonl" },
    ]);
    mockParseConversationFile.mockReturnValue([makeParsedSession()]);
    mockSessionExists.mockReturnValue(true);

    const result = runIngest();

    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("increments errors when parseConversationFile throws", () => {
    mockDiscoverProjects.mockReturnValue([
      { name: "bad-project", conversationFile: "/bad/path.jsonl" },
    ]);
    mockParseConversationFile.mockImplementation(() => {
      throw new Error("ENOENT: file not found");
    });

    const result = runIngest();

    expect(result.errors).toBe(1);
    expect(result.ingested).toBe(0);
  });

  it("increments errors when writeSession throws", () => {
    mockDiscoverProjects.mockReturnValue([{ name: "proj", conversationFile: "/fake.jsonl" }]);
    mockParseConversationFile.mockReturnValue([makeParsedSession()]);
    mockSessionExists.mockReturnValue(false);
    mockWriteSession.mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = runIngest();

    expect(result.errors).toBe(1);
    expect(result.ingested).toBe(0);
  });

  it("handles multiple sessions from one project file", () => {
    mockDiscoverProjects.mockReturnValue([{ name: "proj", conversationFile: "/fake.jsonl" }]);
    mockParseConversationFile.mockReturnValue([
      makeParsedSession({ session_id: "s1" }),
      makeParsedSession({ session_id: "s2" }),
      makeParsedSession({ session_id: "s3" }),
    ]);
    mockSessionExists.mockReturnValue(false);

    const result = runIngest();

    expect(result.ingested).toBe(3);
    expect(mockWriteSession).toHaveBeenCalledTimes(3);
  });

  it("mixes ingested, skipped, and errored sessions in one pass", () => {
    mockDiscoverProjects.mockReturnValue([
      { name: "proj-a", conversationFile: "/a.jsonl" },
      { name: "proj-b", conversationFile: "/b.jsonl" },
    ]);

    mockParseConversationFile
      .mockReturnValueOnce([
        makeParsedSession({ session_id: "new-1" }),
        makeParsedSession({ session_id: "dup-1" }),
      ])
      .mockImplementationOnce(() => {
        throw new Error("parse failure");
      });

    mockSessionExists.mockImplementation((id: string) => id === "dup-1");

    const result = runIngest();

    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("passes includeSlugs and excludeSlugs from config to discoverProjects", () => {
    mockReadConfig.mockReturnValue({ include: ["extra-project"], exclude: ["excluded"] });
    mockDiscoverProjects.mockReturnValue([]);

    runIngest();

    expect(mockDiscoverProjects).toHaveBeenCalledWith(
      undefined,
      expect.arrayContaining(["extra-project"]),
      expect.arrayContaining(["excluded"]),
    );
  });

  it("uses the custom claudeDir when provided", () => {
    mockDiscoverProjects.mockReturnValue([]);

    runIngest({ claudeDir: "/custom/claude/dir" });

    expect(mockDiscoverProjects).toHaveBeenCalledWith(
      "/custom/claude/dir",
      expect.any(Array),
      expect.any(Array),
    );
  });

  it("calls writeSession with ingested_at and author metadata", () => {
    mockDiscoverProjects.mockReturnValue([{ name: "proj", conversationFile: "/fake.jsonl" }]);
    mockParseConversationFile.mockReturnValue([makeParsedSession()]);
    mockSessionExists.mockReturnValue(false);
    mockGetGitAuthor.mockReturnValue("Test Author");

    runIngest();

    const callArgs = mockWriteSession.mock.calls[0][0] as SessionSummary;
    expect(callArgs.ingested_at).toBeTruthy();
    expect(callArgs.author).toBe("Test Author");
    expect(callArgs.projectAlias).toBeTruthy();
  });

  it("logs verbose output when verbose option is true", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDiscoverProjects.mockReturnValue([{ name: "proj", conversationFile: "/fake.jsonl" }]);
    mockParseConversationFile.mockReturnValue([makeParsedSession()]);
    mockSessionExists.mockReturnValue(false);

    runIngest({ verbose: true });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("does not log when verbose is false", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDiscoverProjects.mockReturnValue([]);

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
    mockDiscoverProjects.mockReturnValue([]);
    await ingestCommand();
    expect(mockAssertInitialised).toHaveBeenCalledOnce();
  });

  it("logs a message when no projects are found", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDiscoverProjects.mockReturnValue([]);

    await ingestCommand();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No Claude Code project logs"));
    consoleSpy.mockRestore();
  });

  it("returns without ingesting when projects list is empty", async () => {
    mockDiscoverProjects.mockReturnValue([]);
    await ingestCommand();
    expect(mockWriteSession).not.toHaveBeenCalled();
  });

  it("ingests a new session and prints a done summary", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDiscoverProjects.mockReturnValue([{ name: "proj", conversationFile: "/fake.jsonl" }]);
    mockParseConversationFile.mockReturnValue([makeParsedSession()]);
    mockSessionExists.mockReturnValue(false);

    await ingestCommand();

    expect(mockWriteSession).toHaveBeenCalledOnce();
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("Done.");
    expect(allLogs).toContain("1 session(s) ingested");
    consoleSpy.mockRestore();
  });

  it("skips duplicate sessions and reports them in the summary", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDiscoverProjects.mockReturnValue([{ name: "proj", conversationFile: "/fake.jsonl" }]);
    mockParseConversationFile.mockReturnValue([makeParsedSession()]);
    mockSessionExists.mockReturnValue(true);

    await ingestCommand();

    expect(mockWriteSession).not.toHaveBeenCalled();
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("1 skipped");
    consoleSpy.mockRestore();
  });

  it("reports parse errors in the summary when they occur", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockDiscoverProjects.mockReturnValue([{ name: "bad", conversationFile: "/bad.jsonl" }]);
    mockParseConversationFile.mockImplementation(() => {
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
    mockDiscoverProjects.mockReturnValue([{ name: "proj", conversationFile: "/fake.jsonl" }]);
    mockParseConversationFile.mockReturnValue([makeParsedSession()]);
    mockSessionExists.mockReturnValue(true); // all skipped

    await ingestCommand();

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).not.toContain("patina status");
    consoleSpy.mockRestore();
  });

  it("prints the status prompt when sessions were ingested", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDiscoverProjects.mockReturnValue([{ name: "proj", conversationFile: "/fake.jsonl" }]);
    mockParseConversationFile.mockReturnValue([makeParsedSession()]);
    mockSessionExists.mockReturnValue(false);

    await ingestCommand();

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("patina status");
    consoleSpy.mockRestore();
  });

  it("uses custom claudeDir when passed as option", async () => {
    mockDiscoverProjects.mockReturnValue([]);

    await ingestCommand({ claudeDir: "/custom/dir" });

    expect(mockDiscoverProjects).toHaveBeenCalledWith(
      "/custom/dir",
      expect.any(Array),
      expect.any(Array),
    );
  });

  it("prints verbose file-by-file output when verbose is true", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDiscoverProjects.mockReturnValue([{ name: "proj", conversationFile: "/fake.jsonl" }]);
    mockParseConversationFile.mockReturnValue([makeParsedSession()]);
    mockSessionExists.mockReturnValue(false);

    await ingestCommand({ verbose: true });

    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("/fake.jsonl");
    consoleSpy.mockRestore();
  });
});
