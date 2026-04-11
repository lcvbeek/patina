import { describe, it, expect } from "vitest";
import { applyDiffToDoc, updateCycleHistory } from "./apply.js";

// ---------------------------------------------------------------------------
// applyDiffToDoc
// ---------------------------------------------------------------------------

const SAMPLE_DOC = `# AI Operating Constitution

## 1. Working Agreements

- Rule one
- Rule two

## 2. Behavior Contract

Some agent content.

---
`;

describe("applyDiffToDoc", () => {
  it("inserts diff inside the matching section", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "1. Working Agreements", "- New rule");
    expect(result).toContain("- New rule");
    // Should appear before Section 2
    const newRuleIdx = result.indexOf("- New rule");
    const section2Idx = result.indexOf("## 2.");
    expect(newRuleIdx).toBeLessThan(section2Idx);
  });

  it("matches section by number prefix alone", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "2. Behavior Contract", "- Added agent");
    expect(result).toContain("- Added agent");
    // Should appear after ## 2. header, before ---
    const addedIdx = result.indexOf("- Added agent");
    const section2Idx = result.indexOf("## 2.");
    expect(addedIdx).toBeGreaterThan(section2Idx);
  });

  it("appends before last --- when section not found", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "99. Nonexistent Section", "- Orphan text");
    expect(result).toContain("- Orphan text");
    // Should appear before the trailing ---
    const textIdx = result.indexOf("- Orphan text");
    const lastHrIdx = result.lastIndexOf("---");
    expect(textIdx).toBeLessThan(lastHrIdx);
  });

  it("appends at end when section not found and no --- in doc", () => {
    const doc = "# Simple doc\n\nSome content.\n";
    const result = applyDiffToDoc(doc, "99. Missing", "- Appended");
    expect(result).toContain("- Appended");
    expect(result.endsWith("- Appended\n") || result.includes("- Appended")).toBe(true);
  });

  it("includes a date comment when appending (section not found path)", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "missing", "some text");
    expect(result).toMatch(/<!-- Added by patina apply \d{4}-\d{2}-\d{2} -->/);
  });

  it("does not bleed insertion into adjacent sections", () => {
    const result = applyDiffToDoc(SAMPLE_DOC, "1. Working Agreements", "- Inserted");
    // The insertion should not appear after the ## 2. header
    const lines = result.split("\n");
    const section2Line = lines.findIndex((l) => l.startsWith("## 2."));
    const insertedLine = lines.findIndex((l) => l.trim() === "- Inserted");
    expect(insertedLine).toBeLessThan(section2Line);
  });
});

// ---------------------------------------------------------------------------
// updateCycleHistory
// ---------------------------------------------------------------------------

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
    // Build a doc with 5 existing rows
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

    // Count data rows (lines starting with | \d)
    const dataRows = result.split("\n").filter((l) => /^\| \d+/.test(l));
    expect(dataRows.length).toBeLessThanOrEqual(5);
  });
});
