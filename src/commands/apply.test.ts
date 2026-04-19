import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyDiffToDoc, updateCycleHistory, updateCycleHistoryFile } from "./apply.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage.js")>();
  return {
    ...actual,
    assertInitialised: vi.fn(),
    readPendingDiff: vi.fn(),
    getDataDir: vi.fn(() => "/tmp/patina-test"),
    LIVING_DOC_FILE: ".patina/PATINA.md",
    SPOKE_FILES: {
      "autonomy-detail": ".patina/context/autonomy-detail.md",
      "incident-log": ".patina/context/incident-log.md",
      "eval-framework": ".patina/context/eval-framework.md",
      "cycle-history": ".patina/context/cycle-history.md",
    },
    CORE_MAX_LINES: 80,
    CORE_MAX_CHARS: 3200,
    resolveTargetFile: vi.fn(() => "/tmp/patina-test/.patina/PATINA.md"),
    ensureSpokeFiles: vi.fn(),
    appendOpportunity: vi.fn(),
  };
});

vi.mock("../lib/lint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/lint.js")>();
  return {
    ...actual,
    lintMarkdown: vi.fn(() => []),
    fixMarkdown: vi.fn((content: string) => content),
  };
});

vi.mock("readline", () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: vi.fn(),
      close: vi.fn(),
    })),
  },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ""),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { applyCommand } from "./apply.js";
import {
  assertInitialised,
  readPendingDiff,
  getDataDir,
  resolveTargetFile,
  ensureSpokeFiles,
  appendOpportunity,
} from "../lib/storage.js";
import { lintMarkdown, fixMarkdown } from "../lib/lint.js";
import fs from "fs";
import readline from "readline";
import type { PendingDiff } from "../lib/storage.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_DOC = `# AI Operating Constitution

## 1. Working Agreements

- Rule one
- Rule two

## 2. Behavior Contract

Some agent content.

---
`;

const HISTORY_PLACEHOLDER_DOC = `# AI Operating Constitution

## 7. Retro Cycle History

| Cycle | Date | Key Insight | Change Made |
|---|---|---|---|
| — | — | — | — |
`;

const HISTORY_WITH_ROWS_DOC = `# AI Operating Constitution

## 7. Retro Cycle History

| Cycle | Date | Key Insight | Change Made |
|---|---|---|---|
| 1 | 2025-01-01 | First insight here | First change |
`;

function makePendingDiff(overrides: Partial<PendingDiff> = {}): PendingDiff {
  return {
    section: "1. Working Agreements",
    rationale: "Token usage can be reduced.",
    diff: "- Prefer targeted reads with line ranges",
    timestamp: "2025-01-15T10:00:00Z",
    opportunity: {
      observation: "Manual status checks are frequent.",
      suggestion: "Automate status reporting.",
      effort: "low",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyDiffToDoc
// ---------------------------------------------------------------------------

describe("applyDiffToDoc", () => {
  it("inserts diff inside the matching section", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "1. Working Agreements", "- New rule");
    expect(result).toContain("- New rule");
    const newRuleIdx = result.indexOf("- New rule");
    const section2Idx = result.indexOf("## 2.");
    expect(newRuleIdx).toBeLessThan(section2Idx);
  });

  it("matches section by number prefix alone", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "2. Behavior Contract", "- Added agent");
    expect(result).toContain("- Added agent");
    const addedIdx = result.indexOf("- Added agent");
    const section2Idx = result.indexOf("## 2.");
    expect(addedIdx).toBeGreaterThan(section2Idx);
  });

  it("appends before last --- when section not found", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "99. Nonexistent Section", "- Orphan text");
    expect(result).toContain("- Orphan text");
    const textIdx = result.indexOf("- Orphan text");
    const lastHrIdx = result.lastIndexOf("---");
    expect(textIdx).toBeLessThan(lastHrIdx);
  });

  it("appends at end when section not found and no --- in doc", () => {
    const doc = "# Simple doc\n\nSome content.\n";
    const result = applyDiffToDoc(doc, "99. Missing", "- Appended");
    expect(result).toContain("- Appended");
  });

  it("includes a date comment when appending (section not found path)", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "missing", "some text");
    expect(result).toMatch(/<!-- Added by patina apply \d{4}-\d{2}-\d{2} -->/);
  });

  it("does not bleed insertion into adjacent sections", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "1. Working Agreements", "- Inserted");
    const lines = result.split("\n");
    const section2Line = lines.findIndex((l) => l.startsWith("## 2."));
    const insertedLine = lines.findIndex((l) => l.trim() === "- Inserted");
    expect(insertedLine).toBeLessThan(section2Line);
  });

  it("preserves existing content when inserting", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "1. Working Agreements", "- New rule");
    expect(result).toContain("- Rule one");
    expect(result).toContain("- Rule two");
    expect(result).toContain("## 2. Behavior Contract");
  });

  it("handles multi-line diff text", () => {
    const diff = "- Line A\n- Line B\n- Line C";
    const result = applyDiffToDoc(SAMPLE_DOC, "1. Working Agreements", diff);
    expect(result).toContain("- Line A");
    expect(result).toContain("- Line B");
    expect(result).toContain("- Line C");
  });

  it("matches section header case-insensitively", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "1. working agreements", "- Case test");
    expect(result).toContain("- Case test");
  });

  it("handles empty document gracefully", () => {
    const result = applyDiffToDoc("", "1. Working Agreements", "- Only content");
    expect(result).toContain("- Only content");
  });

  it("handles diff with empty string", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "1. Working Agreements", "");
    // Should not throw, content should be mostly unchanged
    expect(result).toContain("- Rule one");
  });

  it("matches section by number even when title text does not match the section name", () => {
    // This hits the secondary numMatch branch: section "2." matches "## 2. Behavior Contract"
    // even when the title text search fails first
    const doc = `# Doc\n\n## 2. Behavior Contract\n\nExisting content.\n\n---\n`;
    // Use only the number prefix, no title text
    const result = applyDiffToDoc(doc, "2.", "- Number-only match");
    expect(result).toContain("- Number-only match");
    const insertIdx = result.indexOf("- Number-only match");
    const headerIdx = result.indexOf("## 2.");
    expect(insertIdx).toBeGreaterThan(headerIdx);
  });

  it("does not add duplicate newlines excessively", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "1. Working Agreements", "- New");
    // Should not have more than 2 consecutive blank lines
    expect(result).not.toMatch(/\n{4,}/);
  });
});

// ---------------------------------------------------------------------------
// updateCycleHistory
// ---------------------------------------------------------------------------

describe("updateCycleHistory", () => {
  it("replaces the placeholder row with a real row", () => {
    const result = updateCycleHistory(HISTORY_PLACEHOLDER_DOC, "Some insight", "Some change");
    expect(result).not.toContain("| — | — | — | — |");
    expect(result).toMatch(/\| 1 \| \d{4}-\d{2}-\d{2} \|/);
  });

  it("appends a new row when no placeholder exists", () => {
    const result = updateCycleHistory(HISTORY_WITH_ROWS_DOC, "New insight", "New change");
    expect(result).toMatch(/\| 2 \| \d{4}-\d{2}-\d{2} \|/);
  });

  it("appends a row even when no table header exists", () => {
    const doc = "# Simple doc\n\nNo history section here.\n";
    const result = updateCycleHistory(doc, "insight", "change");
    expect(result).toMatch(/\| 1 \| \d{4}-\d{2}-\d{2} \|/);
  });

  it("caps history at 5 rows (drops oldest when over cap)", () => {
    const rows = Array.from(
      { length: 5 },
      (_, i) => `| ${i + 1} | 2025-0${i + 1}-01 | Insight ${i + 1} | Change ${i + 1} |`,
    ).join("\n");

    const doc = `# AI Operating Constitution

## 7. Retro Cycle History

| Cycle | Date | Key Insight | Change Made |
|---|---|---|---|
${rows}
`;
    const result = updateCycleHistory(doc, "Latest insight", "Latest change");
    const dataRows = result.split("\n").filter((l) => /^\| \d+/.test(l));
    expect(dataRows.length).toBeLessThanOrEqual(5);
  });

  it("truncates insight to 60 chars followed by ...", () => {
    const longInsight = "A".repeat(80);
    const result = updateCycleHistory(HISTORY_PLACEHOLDER_DOC, longInsight, "Short change");
    // The row should contain "AAAA..." (truncated to 60 chars + ...)
    expect(result).toContain("A".repeat(60) + "...");
  });

  it("truncates change desc to 50 chars followed by ...", () => {
    const longChange = "B".repeat(70);
    const result = updateCycleHistory(HISTORY_PLACEHOLDER_DOC, "Short insight", longChange);
    expect(result).toContain("B".repeat(50) + "...");
  });

  it("uses today's date in the new row", () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = updateCycleHistory(HISTORY_PLACEHOLDER_DOC, "insight", "change");
    expect(result).toContain(`| ${today}`);
  });

  it("increments cycle count based on existing rows", () => {
    // Doc with 3 existing rows
    const doc = `# History

| Cycle | Date | Key Insight | Change Made |
|---|---|---|---|
| 1 | 2025-01-01 | Insight 1 | Change 1 |
| 2 | 2025-02-01 | Insight 2 | Change 2 |
| 3 | 2025-03-01 | Insight 3 | Change 3 |
`;
    const result = updateCycleHistory(doc, "New insight", "New change");
    expect(result).toMatch(/\| 4 \| \d{4}-\d{2}-\d{2} \|/);
  });
});

// ---------------------------------------------------------------------------
// updateCycleHistoryFile
// ---------------------------------------------------------------------------

describe("updateCycleHistoryFile", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(ensureSpokeFiles).mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue(HISTORY_PLACEHOLDER_DOC);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
  });

  it("creates spoke files if the file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    updateCycleHistoryFile("/tmp/test", "insight", "change");
    expect(ensureSpokeFiles).toHaveBeenCalled();
  });

  it("reads existing spoke file when it exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(HISTORY_WITH_ROWS_DOC);
    updateCycleHistoryFile("/tmp/test", "insight", "change");
    expect(fs.readFileSync).toHaveBeenCalled();
  });

  it("writes updated content back to the spoke file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(HISTORY_PLACEHOLDER_DOC);
    updateCycleHistoryFile("/tmp/test", "insight", "change");
    expect(fs.writeFileSync).toHaveBeenCalledOnce();
    const [, writtenContent] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(writtenContent).not.toContain("| — | — | — | — |");
  });
});

// ---------------------------------------------------------------------------
// applyCommand — integration tests
// ---------------------------------------------------------------------------

describe("applyCommand", () => {
  const mockReadlineInterface = {
    question: vi.fn(),
    close: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    vi.mocked(readline.createInterface).mockReturnValue(
      mockReadlineInterface as ReturnType<typeof readline.createInterface>,
    );

    // Default: no pending diff
    vi.mocked(readPendingDiff).mockReturnValue(null);
    vi.mocked(getDataDir).mockReturnValue("/tmp/patina-test");
    vi.mocked(resolveTargetFile).mockReturnValue("/tmp/patina-test/.patina/PATINA.md");
    vi.mocked(ensureSpokeFiles).mockImplementation(() => {});
    vi.mocked(appendOpportunity).mockImplementation(() => {});
    vi.mocked(lintMarkdown).mockReturnValue([]);
    vi.mocked(fixMarkdown).mockImplementation((c: string) => c);

    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_DOC);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a message and returns when no pending diff exists", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(null);
    await applyCommand({ yes: true });
    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("No pending diff");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("logs abort message when user declines confirmation", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    // Simulate user pressing 'n' via readline
    mockReadlineInterface.question.mockImplementation(
      (_question: string, callback: (answer: string) => void) => {
        callback("n");
        mockReadlineInterface.close();
      },
    );
    await applyCommand();
    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("Aborted");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("applies the diff when options.yes is true (skips confirmation)", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_DOC);

    await applyCommand({ yes: true });

    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("writes modified content to the target file", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_DOC);

    await applyCommand({ yes: true });

    const writeCall = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([path]) => String(path).includes("PATINA.md"));
    expect(writeCall).toBeDefined();
  });

  it("calls fixMarkdown on the modified content", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_DOC);

    await applyCommand({ yes: true });

    expect(fixMarkdown).toHaveBeenCalled();
  });

  it("calls lintMarkdown after writing", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_DOC);

    await applyCommand({ yes: true });

    expect(lintMarkdown).toHaveBeenCalled();
  });

  it("logs lint warnings when lintMarkdown returns issues", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_DOC);
    vi.mocked(lintMarkdown).mockReturnValue([
      { line: 5, rule: "MD032", message: "List needs blank line" },
    ]);

    await applyCommand({ yes: true });

    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("lint warning");
  });

  it("shows truncation note when more than 5 lint warnings", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_DOC);
    vi.mocked(lintMarkdown).mockReturnValue(
      Array.from({ length: 8 }, (_, i) => ({
        line: i + 1,
        rule: "MD032",
        message: `Warning ${i}`,
      })),
    );

    await applyCommand({ yes: true });

    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("more");
  });

  it("removes the pending-diff.json file after applying", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    // Make pending diff file exist so unlinkSync is called
    vi.mocked(fs.existsSync).mockImplementation((p: string | Buffer | URL) => {
      return String(p).includes("pending-diff");
    });

    await applyCommand({ yes: true });

    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining("pending-diff"));
  });

  it("calls appendOpportunity when pending diff has opportunity", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await applyCommand({ yes: true });

    expect(appendOpportunity).toHaveBeenCalledOnce();
  });

  it("does not call appendOpportunity when pending diff has no opportunity", async () => {
    const pendingWithoutOpportunity: PendingDiff = {
      section: "1. Working Agreements",
      rationale: "Some rationale",
      diff: "- Some diff",
      timestamp: "2025-01-15T10:00:00Z",
    };
    vi.mocked(readPendingDiff).mockReturnValue(pendingWithoutOpportunity);

    await applyCommand({ yes: true });

    expect(appendOpportunity).not.toHaveBeenCalled();
  });

  it("calls ensureSpokeFiles before applying", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());

    await applyCommand({ yes: true });

    expect(ensureSpokeFiles).toHaveBeenCalled();
  });

  it("updates the metrics.json cycle count when file exists", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockImplementation((p: string | Buffer | URL) => {
      return String(p).includes("metrics.json");
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: string | Buffer | URL | number) => {
      if (String(p).includes("metrics.json")) {
        return JSON.stringify({ cycles_completed: 2 });
      }
      return SAMPLE_DOC;
    });

    await applyCommand({ yes: true });

    const metricWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([p]) => String(p).includes("metrics.json"));
    expect(metricWrite).toBeDefined();
    const writtenContent = String(metricWrite?.[1]);
    const parsed = JSON.parse(writtenContent) as { cycles_completed: number };
    expect(parsed.cycles_completed).toBe(3);
  });

  it("does not throw when metrics.json is malformed", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockImplementation((p: string | Buffer | URL) => {
      return String(p).includes("metrics.json");
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: string | Buffer | URL | number) => {
      if (String(p).includes("metrics.json")) {
        return "{ invalid json }";
      }
      return SAMPLE_DOC;
    });

    // Should not throw
    await expect(applyCommand({ yes: true })).resolves.toBeUndefined();
  });

  it("updates the last-updated timestamp in core PATINA.md when it exists", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    const docWithTimestamp =
      "# AI Operating Constitution\n\n> Last updated: 2025-01-01\n\n## 1. Working Agreements\n\n- Existing rule\n";
    vi.mocked(fs.existsSync).mockImplementation((p: string | Buffer | URL) => {
      return String(p).includes("PATINA.md");
    });
    vi.mocked(fs.readFileSync).mockReturnValue(docWithTimestamp);

    await applyCommand({ yes: true });

    const today = new Date().toISOString().slice(0, 10);
    // Find the last write to PATINA.md — the timestamp update write
    const patinaWrites = vi
      .mocked(fs.writeFileSync)
      .mock.calls.filter(([p]) => String(p).includes("PATINA.md"));
    expect(patinaWrites.length).toBeGreaterThan(0);
    // The last write (timestamp update) should contain the new date
    const lastWrite = patinaWrites[patinaWrites.length - 1];
    expect(String(lastWrite[1])).toContain(`Last updated: ${today}`);
  });

  it("warns when core PATINA.md exceeds line cap", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    // Create content exceeding CORE_MAX_LINES (80)
    const overLimitDoc = Array.from({ length: 90 }, (_, i) => `Line ${i}`).join("\n");
    vi.mocked(fs.existsSync).mockImplementation((p: string | Buffer | URL) => {
      return String(p).includes("PATINA.md");
    });
    vi.mocked(fs.readFileSync).mockReturnValue(overLimitDoc);

    await applyCommand({ yes: true });

    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("exceeds limits");
  });

  it("logs the applied file path in success output", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await applyCommand({ yes: true });

    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("Applied");
  });

  it("logs 'Cycle history updated' on success", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await applyCommand({ yes: true });

    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("Cycle history updated");
  });

  it("logs 'Pending diff cleared' on success", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await applyCommand({ yes: true });

    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("Pending diff cleared");
  });

  it("logs the post-write PATINA core estimate", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockImplementation((p: string | Buffer | URL) => {
      return String(p).includes("PATINA.md");
    });
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_DOC);

    await applyCommand({ yes: true });

    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("Core PATINA.md now ~");
  });

  it("logs 'Opportunity added' when opportunity was present", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await applyCommand({ yes: true });

    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("Opportunity added");
  });

  it("calls assertInitialised at the start", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(null);
    await applyCommand({ yes: true });
    expect(assertInitialised).toHaveBeenCalledOnce();
  });

  it("displays the pending diff rationale in output", async () => {
    const pending = makePendingDiff({ rationale: "Very specific rationale for this test" });
    vi.mocked(readPendingDiff).mockReturnValue(pending);

    await applyCommand({ yes: true });

    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("Very specific rationale for this test");
  });

  it("displays the pending diff lines in output", async () => {
    const pending = makePendingDiff({ diff: "- My unique test diff line" });
    vi.mocked(readPendingDiff).mockReturnValue(pending);

    await applyCommand({ yes: true });

    const consoleCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(consoleCalls).toContain("My unique test diff line");
  });

  it("creates target file with default core template when file does not exist and is core", async () => {
    // resolveTargetFile returns the PATINA.md path (core file)
    vi.mocked(resolveTargetFile).mockReturnValue("/tmp/patina-test/.patina/PATINA.md");
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await applyCommand({ yes: true });

    // Should write to the core file — writeFileSync called with PATINA.md path
    const coreWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([p]) => String(p).includes("PATINA.md"));
    expect(coreWrite).toBeDefined();
  });

  it("calls readline.createInterface when no yes option", async () => {
    vi.mocked(readPendingDiff).mockReturnValue(makePendingDiff());
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_DOC);
    // Simulate user answering 'y'
    mockReadlineInterface.question.mockImplementation(
      (_question: string, callback: (answer: string) => void) => {
        callback("y");
        mockReadlineInterface.close();
      },
    );

    await applyCommand();

    expect(readline.createInterface).toHaveBeenCalledOnce();
  });
});
