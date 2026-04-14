import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  ensureDir,
  writeJson,
  readJson,
  fileExists,
  writeSession,
  sessionExists,
  sessionFilePath,
  readAllSessions,
  writeCapture,
  readCaptures,
  writeReflection,
  readReflections,
  writePendingDiff,
  readPendingDiff,
  writeMetrics,
  readMetrics,
  resolveTargetFile,
  loadSpokeFiles,
  loadOpportunityBacklog,
  appendOpportunity,
  ensureSpokeFiles,
  getDataDir,
  readConfig,
  cycleFilePath,
  getLatestCycleDate,
  writeCycleFile,
  patinaExists,
  LIVING_DOC_FILE,
  SPOKE_FILES,
  type SessionSummary,
  type Capture,
  type Reflection,
  type PendingDiff,
  type Metrics,
} from "./storage.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "patina-storage-test-"));
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: "test-session-001",
    project: "test-project",
    timestamp: "2025-01-15T10:00:00Z",
    turn_count: 4,
    estimated_tokens: 1000,
    tool_calls: { Read: 2 },
    had_rework: false,
    ingested_at: "2025-01-15T10:05:00Z",
    ...overrides,
  };
}

function makeCapture(overrides: Partial<Capture> = {}): Capture {
  return {
    id: "cap-001",
    text: "Something notable happened",
    author: "Leo",
    timestamp: "2025-01-15T10:00:00Z",
    ...overrides,
  };
}

function makeReflection(overrides: Partial<Reflection> = {}): Reflection {
  return {
    id: "ref-001",
    author: "Leo",
    timestamp: "2025-01-15T10:00:00Z",
    cycleStart: "2025-01-01",
    answers: { overall_feel: "Good", went_well: "Tests" },
    ...overrides,
  };
}

function makePendingDiff(overrides: Partial<PendingDiff> = {}): PendingDiff {
  return {
    section: "1. Working Agreements",
    rationale: "Scope creep occurred",
    diff: "- Scope: Stay within the stated task.",
    timestamp: "2025-01-15T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  process.env.PATINA_DATA_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.PATINA_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ensureDir
// ---------------------------------------------------------------------------

describe("ensureDir", () => {
  it("creates a directory that does not exist", () => {
    const target = path.join(tmpDir, "nested", "deep", "dir");
    ensureDir(target);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("does not throw if the directory already exists", () => {
    const target = path.join(tmpDir, "already-exists");
    fs.mkdirSync(target);
    expect(() => ensureDir(target)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// writeJson / readJson
// ---------------------------------------------------------------------------

describe("writeJson", () => {
  it("writes a JSON file to disk with proper formatting", () => {
    const filePath = path.join(tmpDir, "test.json");
    writeJson(filePath, { key: "value", count: 42 });
    const raw = fs.readFileSync(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ key: "value", count: 42 });
  });

  it("creates parent directories automatically", () => {
    const filePath = path.join(tmpDir, "sub", "dir", "data.json");
    writeJson(filePath, { x: 1 });
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("overwrites an existing file", () => {
    const filePath = path.join(tmpDir, "overwrite.json");
    writeJson(filePath, { v: 1 });
    writeJson(filePath, { v: 2 });
    const result = readJson<{ v: number }>(filePath);
    expect(result.v).toBe(2);
  });
});

describe("readJson", () => {
  it("parses and returns data from a JSON file", () => {
    const filePath = path.join(tmpDir, "read-test.json");
    fs.writeFileSync(filePath, JSON.stringify({ answer: 42 }), "utf-8");
    const result = readJson<{ answer: number }>(filePath);
    expect(result.answer).toBe(42);
  });

  it("throws when file does not exist", () => {
    expect(() => readJson(path.join(tmpDir, "nonexistent.json"))).toThrow();
  });

  it("throws on malformed JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "{ not valid json {{", "utf-8");
    expect(() => readJson(filePath)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// fileExists
// ---------------------------------------------------------------------------

describe("fileExists", () => {
  it("returns true for an existing file", () => {
    const filePath = path.join(tmpDir, "exists.txt");
    fs.writeFileSync(filePath, "hi");
    expect(fileExists(filePath)).toBe(true);
  });

  it("returns false for a missing file", () => {
    expect(fileExists(path.join(tmpDir, "missing.txt"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

describe("sessionFilePath", () => {
  it("returns a path inside the sessions subdirectory of dataDir", () => {
    const fp = sessionFilePath("abc-123", tmpDir);
    expect(fp).toContain("sessions");
    expect(fp).toContain("abc-123");
  });

  it("sanitises special characters in session IDs", () => {
    const fp = sessionFilePath("abc/def:ghi", tmpDir);
    expect(fp).not.toContain("/def");
    expect(fp).not.toContain(":");
  });
});

describe("sessionExists", () => {
  it("returns false when no session file has been written", () => {
    expect(sessionExists("unknown-session", tmpDir)).toBe(false);
  });

  it("returns true after a session has been written", () => {
    const summary = makeSession({ session_id: "s-exists" });
    writeSession(summary, tmpDir);
    expect(sessionExists("s-exists", tmpDir)).toBe(true);
  });
});

describe("writeSession / readAllSessions", () => {
  it("round-trips a session through disk correctly", () => {
    const summary = makeSession();
    writeSession(summary, tmpDir);
    const all = readAllSessions(tmpDir);
    expect(all).toHaveLength(1);
    expect(all[0].session_id).toBe("test-session-001");
    expect(all[0].turn_count).toBe(4);
  });

  it("returns empty array when sessions directory does not exist", () => {
    delete process.env.PATINA_DATA_DIR;
    const emptyDir = makeTmpDir();
    const result = readAllSessions(emptyDir);
    fs.rmSync(emptyDir, { recursive: true, force: true });
    expect(result).toEqual([]);
  });

  it("writes multiple sessions and reads them all back", () => {
    writeSession(makeSession({ session_id: "s1" }), tmpDir);
    writeSession(makeSession({ session_id: "s2" }), tmpDir);
    writeSession(makeSession({ session_id: "s3" }), tmpDir);
    const all = readAllSessions(tmpDir);
    expect(all).toHaveLength(3);
  });

  it("skips malformed session files and continues", () => {
    writeSession(makeSession({ session_id: "good" }), tmpDir);
    // Write a bad JSON file into the sessions directory
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "bad.json"), "{ invalid json", "utf-8");
    const all = readAllSessions(tmpDir);
    expect(all.some((s) => s.session_id === "good")).toBe(true);
  });

  it("rejects invalid session data via Zod schema", () => {
    expect(() => writeSession({ ...makeSession(), turn_count: -1 }, tmpDir)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

describe("writeCapture", () => {
  it("writes a capture file to the captures directory", () => {
    const capture = makeCapture();
    writeCapture(capture, tmpDir);
    const capturesDir = path.join(tmpDir, "captures");
    const files = fs.readdirSync(capturesDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("cap-001");
  });

  it("creates the captures directory if it does not exist", () => {
    const capturesDir = path.join(tmpDir, "captures");
    writeCapture(makeCapture(), tmpDir);
    expect(fs.existsSync(capturesDir)).toBe(true);
  });

  it("sanitises special characters in the capture ID for file naming", () => {
    const capture = makeCapture({ id: "cap/with:special" });
    writeCapture(capture, tmpDir);
    const capturesDir = path.join(tmpDir, "captures");
    const files = fs.readdirSync(capturesDir);
    expect(files[0]).not.toContain("/");
    expect(files[0]).not.toContain(":");
  });
});

describe("readCaptures", () => {
  it("returns empty array when captures directory does not exist", () => {
    delete process.env.PATINA_DATA_DIR;
    const freshDir = makeTmpDir();
    const result = readCaptures(freshDir);
    fs.rmSync(freshDir, { recursive: true, force: true });
    expect(result).toEqual([]);
  });

  it("reads captures back in timestamp order", () => {
    writeCapture(makeCapture({ id: "b", timestamp: "2025-01-02T00:00:00Z" }), tmpDir);
    writeCapture(makeCapture({ id: "a", timestamp: "2025-01-01T00:00:00Z" }), tmpDir);
    const captures = readCaptures(tmpDir);
    expect(captures[0].id).toBe("a");
    expect(captures[1].id).toBe("b");
  });

  it("filters captures by sinceDate", () => {
    writeCapture(makeCapture({ id: "old", timestamp: "2025-01-01T00:00:00Z" }), tmpDir);
    writeCapture(makeCapture({ id: "new", timestamp: "2025-02-01T00:00:00Z" }), tmpDir);
    const captures = readCaptures(tmpDir, "2025-01-15");
    expect(captures).toHaveLength(1);
    expect(captures[0].id).toBe("new");
  });

  it("returns all captures when sinceDate is null", () => {
    writeCapture(makeCapture({ id: "x1" }), tmpDir);
    writeCapture(makeCapture({ id: "x2" }), tmpDir);
    const captures = readCaptures(tmpDir, null);
    expect(captures).toHaveLength(2);
  });

  it("includes optional tag field when present", () => {
    writeCapture(makeCapture({ id: "tagged", tag: "near-miss" }), tmpDir);
    const captures = readCaptures(tmpDir);
    expect(captures[0].tag).toBe("near-miss");
  });
});

// ---------------------------------------------------------------------------
// Reflection helpers
// ---------------------------------------------------------------------------

describe("writeReflection / readReflections", () => {
  it("round-trips a reflection through disk", () => {
    const ref = makeReflection();
    writeReflection(ref, tmpDir);
    const all = readReflections(tmpDir);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("ref-001");
    expect(all[0].answers.overall_feel).toBe("Good");
  });

  it("returns empty array when reflections directory does not exist", () => {
    delete process.env.PATINA_DATA_DIR;
    const freshDir = makeTmpDir();
    const result = readReflections(freshDir);
    fs.rmSync(freshDir, { recursive: true, force: true });
    expect(result).toEqual([]);
  });

  it("sorts reflections by timestamp ascending", () => {
    writeReflection(makeReflection({ id: "r2", timestamp: "2025-01-02T00:00:00Z" }), tmpDir);
    writeReflection(makeReflection({ id: "r1", timestamp: "2025-01-01T00:00:00Z" }), tmpDir);
    const all = readReflections(tmpDir);
    expect(all[0].id).toBe("r1");
    expect(all[1].id).toBe("r2");
  });

  it("filters reflections since a given date", () => {
    writeReflection(makeReflection({ id: "old", timestamp: "2025-01-01T00:00:00Z" }), tmpDir);
    writeReflection(makeReflection({ id: "recent", timestamp: "2025-02-10T00:00:00Z" }), tmpDir);
    const filtered = readReflections(tmpDir, "2025-01-15");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("recent");
  });
});

// ---------------------------------------------------------------------------
// Pending diff helpers
// ---------------------------------------------------------------------------

describe("writePendingDiff / readPendingDiff", () => {
  it("returns null when no pending diff exists", () => {
    expect(readPendingDiff(tmpDir)).toBeNull();
  });

  it("round-trips a pending diff", () => {
    const diff = makePendingDiff();
    writePendingDiff(diff, tmpDir);
    const result = readPendingDiff(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.section).toBe("1. Working Agreements");
    expect(result!.diff).toBe("- Scope: Stay within the stated task.");
  });

  it("returns null when the pending diff file is corrupted", () => {
    const file = path.join(tmpDir, "pending-diff.json");
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(file, "{ broken json {{{", "utf-8");
    expect(readPendingDiff(tmpDir)).toBeNull();
  });

  it("persists optional opportunity field", () => {
    const diff = makePendingDiff({
      opportunity: {
        observation: "Manual status checks",
        suggestion: "Automate reporting",
        effort: "low",
      },
    });
    writePendingDiff(diff, tmpDir);
    const result = readPendingDiff(tmpDir);
    expect(result!.opportunity?.suggestion).toBe("Automate reporting");
  });
});

// ---------------------------------------------------------------------------
// Metrics helpers
// ---------------------------------------------------------------------------

describe("readMetrics / writeMetrics", () => {
  it("returns default empty metrics when no file exists", () => {
    const m = readMetrics(tmpDir);
    expect(m.cycles).toEqual([]);
    expect(typeof m.last_updated).toBe("string");
  });

  it("round-trips metrics", () => {
    const metrics: Metrics = {
      last_updated: "2025-01-15T00:00:00Z",
      cycles: [
        {
          cycle_id: "c1",
          created_at: "2025-01-15T00:00:00Z",
          session_count: 3,
          total_tokens: 9000,
          rework_count: 1,
        },
      ],
    };
    writeMetrics(metrics, tmpDir);
    const result = readMetrics(tmpDir);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0].cycle_id).toBe("c1");
    expect(result.cycles[0].session_count).toBe(3);
  });

  it("returns default metrics when the file is corrupted", () => {
    const file = path.join(tmpDir, "metrics.json");
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(file, "INVALID", "utf-8");
    const m = readMetrics(tmpDir);
    expect(m.cycles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveTargetFile
// ---------------------------------------------------------------------------

describe("resolveTargetFile", () => {
  it("routes section 1 to the core PATINA.md", () => {
    const result = resolveTargetFile("1. Working Agreements", tmpDir);
    expect(result).toContain(LIVING_DOC_FILE);
  });

  it("routes section 2 to the core PATINA.md", () => {
    const result = resolveTargetFile("2. Behavior Contract", tmpDir);
    expect(result).toContain(LIVING_DOC_FILE);
  });

  it("routes section 4 to the autonomy-detail spoke file", () => {
    const result = resolveTargetFile("4. Autonomy Detail", tmpDir);
    expect(result).toContain(SPOKE_FILES["autonomy-detail"]);
  });

  it("routes section 5 to the incident-log spoke file", () => {
    const result = resolveTargetFile("5. Incident Log", tmpDir);
    expect(result).toContain(SPOKE_FILES["incident-log"]);
  });

  it("routes section 6 to the eval-framework spoke file", () => {
    const result = resolveTargetFile("6. Eval Framework", tmpDir);
    expect(result).toContain(SPOKE_FILES["eval-framework"]);
  });

  it("routes section 7 to the cycle-history spoke file", () => {
    const result = resolveTargetFile("7. Cycle History", tmpDir);
    expect(result).toContain(SPOKE_FILES["cycle-history"]);
  });

  it("routes 'incident' keyword to incident-log when no number prefix", () => {
    const result = resolveTargetFile("Incident Summary", tmpDir);
    expect(result).toContain(SPOKE_FILES["incident-log"]);
  });

  it("routes 'eval' keyword to eval-framework when no number prefix", () => {
    const result = resolveTargetFile("Eval Results", tmpDir);
    expect(result).toContain(SPOKE_FILES["eval-framework"]);
  });

  it("falls back to core PATINA.md for unknown section names", () => {
    const result = resolveTargetFile("Unknown Section XYZ", tmpDir);
    expect(result).toContain(LIVING_DOC_FILE);
  });
});

// ---------------------------------------------------------------------------
// loadSpokeFiles
// ---------------------------------------------------------------------------

describe("loadSpokeFiles", () => {
  it("returns placeholder comments for missing spoke files", () => {
    const result = loadSpokeFiles(tmpDir);
    expect(result).toContain("no data yet");
  });

  it("includes content from existing spoke files", () => {
    const spokeDir = path.join(tmpDir, ".patina", "context");
    fs.mkdirSync(spokeDir, { recursive: true });
    fs.writeFileSync(
      path.join(spokeDir, "incident-log.md"),
      "# Incident Log\nSome incident",
      "utf-8",
    );
    const result = loadSpokeFiles(tmpDir);
    expect(result).toContain("Some incident");
  });
});

// ---------------------------------------------------------------------------
// loadOpportunityBacklog / appendOpportunity
// ---------------------------------------------------------------------------

describe("loadOpportunityBacklog", () => {
  it("returns null when the file does not exist", () => {
    expect(loadOpportunityBacklog(tmpDir)).toBeNull();
  });

  it("returns null for an empty file", () => {
    const filePath = path.join(tmpDir, ".patina", "opportunity-backlog.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "", "utf-8");
    expect(loadOpportunityBacklog(tmpDir)).toBeNull();
  });

  it("returns file content when the file exists and is non-empty", () => {
    const filePath = path.join(tmpDir, ".patina", "opportunity-backlog.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "# Opportunities\n- item", "utf-8");
    const result = loadOpportunityBacklog(tmpDir);
    expect(result).toContain("item");
  });
});

describe("appendOpportunity", () => {
  // appendOpportunity requires the parent .patina/ directory to already exist —
  // it does not auto-create it. Tests must initialise the directory first.
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, ".patina"), { recursive: true });
  });

  it("creates the backlog file with a header when it does not exist", () => {
    appendOpportunity(tmpDir, {
      observation: "Tests are missing",
      suggestion: "Add unit tests",
      effort: "medium",
    });
    const result = loadOpportunityBacklog(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Add unit tests");
  });

  it("appends to an existing backlog file", () => {
    appendOpportunity(tmpDir, {
      observation: "First item",
      suggestion: "Do first thing",
      effort: "low",
    });
    appendOpportunity(tmpDir, {
      observation: "Second item",
      suggestion: "Do second thing",
      effort: "high",
    });
    const result = loadOpportunityBacklog(tmpDir);
    expect(result).toContain("Do first thing");
    expect(result).toContain("Do second thing");
  });

  it("includes the effort level and today's date in the entry", () => {
    const today = new Date().toISOString().slice(0, 10);
    appendOpportunity(tmpDir, {
      observation: "Observation",
      suggestion: "Suggestion",
      effort: "low",
    });
    const result = loadOpportunityBacklog(tmpDir);
    expect(result).toContain("low effort");
    expect(result).toContain(today);
  });
});

// ---------------------------------------------------------------------------
// ensureSpokeFiles
// ---------------------------------------------------------------------------

describe("ensureSpokeFiles", () => {
  it("creates all four spoke files when they do not exist", () => {
    ensureSpokeFiles(tmpDir);
    for (const relPath of Object.values(SPOKE_FILES)) {
      expect(fs.existsSync(path.join(tmpDir, relPath))).toBe(true);
    }
  });

  it("does not overwrite existing spoke files", () => {
    const spokeDir = path.join(tmpDir, ".patina", "context");
    fs.mkdirSync(spokeDir, { recursive: true });
    const incidentPath = path.join(tmpDir, SPOKE_FILES["incident-log"]);
    fs.writeFileSync(incidentPath, "# Custom Content", "utf-8");
    ensureSpokeFiles(tmpDir);
    const content = fs.readFileSync(incidentPath, "utf-8");
    expect(content).toBe("# Custom Content");
  });
});

// ---------------------------------------------------------------------------
// patinaExists
// ---------------------------------------------------------------------------

describe("patinaExists", () => {
  it("returns false when .patina does not exist in cwd", () => {
    const freshDir = makeTmpDir();
    const result = patinaExists(freshDir);
    fs.rmSync(freshDir, { recursive: true, force: true });
    expect(result).toBe(false);
  });

  it("returns true when .patina directory exists", () => {
    fs.mkdirSync(path.join(tmpDir, ".patina"), { recursive: true });
    expect(patinaExists(tmpDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getDataDir
// ---------------------------------------------------------------------------

describe("getDataDir", () => {
  it("returns PATINA_DATA_DIR env var when set", () => {
    process.env.PATINA_DATA_DIR = "/custom/data/dir";
    const result = getDataDir(tmpDir);
    expect(result).toBe("/custom/data/dir");
    process.env.PATINA_DATA_DIR = tmpDir; // restore for afterEach
  });

  it("falls back to ~/.patina/projects/<slug> when env var not set and no config", () => {
    delete process.env.PATINA_DATA_DIR;
    const freshDir = makeTmpDir();
    const result = getDataDir(freshDir);
    expect(result).toContain(path.join(".patina", "projects"));
    fs.rmSync(freshDir, { recursive: true, force: true });
    process.env.PATINA_DATA_DIR = tmpDir; // restore for afterEach
  });
});

// ---------------------------------------------------------------------------
// readConfig
// ---------------------------------------------------------------------------

describe("readConfig", () => {
  it("returns default config when no config file exists", () => {
    delete process.env.PATINA_DATA_DIR;
    const freshDir = makeTmpDir();
    const cfg = readConfig(freshDir);
    expect(cfg.include).toEqual([]);
    expect(cfg.retroReminderAfterSessions).toBe(10);
    fs.rmSync(freshDir, { recursive: true, force: true });
    process.env.PATINA_DATA_DIR = tmpDir;
  });

  it("reads and merges config from .patina/config.json", () => {
    const patinaDir = path.join(tmpDir, ".patina");
    fs.mkdirSync(patinaDir, { recursive: true });
    fs.writeFileSync(
      path.join(patinaDir, "config.json"),
      JSON.stringify({ include: ["my-project"], retroReminderAfterSessions: 5 }),
      "utf-8",
    );
    const cfg = readConfig(tmpDir);
    expect(cfg.include).toEqual(["my-project"]);
    expect(cfg.retroReminderAfterSessions).toBe(5);
  });

  it("returns default config when config file is malformed JSON", () => {
    const patinaDir = path.join(tmpDir, ".patina");
    fs.mkdirSync(patinaDir, { recursive: true });
    fs.writeFileSync(path.join(patinaDir, "config.json"), "not json {{", "utf-8");
    const cfg = readConfig(tmpDir);
    expect(cfg.include).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cycle file helpers
// ---------------------------------------------------------------------------

describe("cycleFilePath", () => {
  it("returns a path containing the date and .md extension", () => {
    const fp = cycleFilePath("2025-01-15", tmpDir);
    expect(fp).toContain("2025-01-15.md");
    expect(fp).toContain("cycles");
  });
});

describe("getLatestCycleDate", () => {
  it("returns null when cycles directory does not exist", () => {
    expect(getLatestCycleDate(tmpDir)).toBeNull();
  });

  it("returns null for an empty cycles directory", () => {
    fs.mkdirSync(path.join(tmpDir, ".patina", "cycles"), { recursive: true });
    expect(getLatestCycleDate(tmpDir)).toBeNull();
  });

  it("returns the latest date when cycle files exist", () => {
    writeCycleFile("2025-01-10", "# Cycle", tmpDir);
    writeCycleFile("2025-01-15", "# Cycle", tmpDir);
    writeCycleFile("2025-01-05", "# Cycle", tmpDir);
    expect(getLatestCycleDate(tmpDir)).toBe("2025-01-15");
  });
});

describe("writeCycleFile", () => {
  it("writes a markdown file to the cycles directory", () => {
    writeCycleFile("2025-06-01", "# My Cycle\n\nContent here.", tmpDir);
    const fp = cycleFilePath("2025-06-01", tmpDir);
    expect(fs.existsSync(fp)).toBe(true);
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("My Cycle");
  });

  it("creates the cycles directory if it does not exist", () => {
    const cyclesDir = path.join(tmpDir, ".patina", "cycles");
    writeCycleFile("2025-06-01", "content", tmpDir);
    expect(fs.existsSync(cyclesDir)).toBe(true);
  });
});
