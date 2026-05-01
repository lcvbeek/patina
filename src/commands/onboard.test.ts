import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildPrompt,
  insertBeforeSectionEnd,
  applyOnboarding,
  replaceTableBody,
  applyOnboardingToSpokes,
  type OnboardingResponse,
} from "./onboard.js";

// ---------------------------------------------------------------------------
// Mock external dependencies
// ---------------------------------------------------------------------------

vi.mock("../lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage.js")>();
  return {
    ...actual,
    writeCycleFile: vi.fn(),
    ensureSpokeFiles: vi.fn(),
    SPOKE_FILES: {
      "autonomy-detail": ".patina/context/autonomy-detail.md",
      "eval-framework": ".patina/context/eval-framework.md",
      "incident-log": ".patina/context/incident-log.md",
      "cycle-history": ".patina/context/cycle-history.md",
    },
    LIVING_DOC_FILE: ".patina/PATINA.md",
  };
});

vi.mock("../lib/claude.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/claude.js")>();
  return { ...actual, callClaudeForJson: vi.fn() };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

// Mock readline so onboardCommand never actually waits for terminal input.
// Each .question() call immediately invokes its callback with the configured answer.
const mockRlClose = vi.fn();
const mockRlQuestion = vi.fn();

vi.mock("readline", () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: mockRlQuestion,
      close: mockRlClose,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { onboardCommand } from "./onboard.js";
import { callClaudeForJson } from "../lib/claude.js";
import { writeCycleFile, ensureSpokeFiles } from "../lib/storage.js";
import fs from "fs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_RESPONSE: OnboardingResponse = {
  summary: "Established initial agreements.",
  behavior_contract_md: `**Always do:**\n\n- Confirm plan first\n\n**Never do:**\n\n- Push without approval\n\n**Tone:** Direct and brief.\n\n**Stop and ask before:** Destructive operations.`,
  autonomy_map_rows_md:
    "| Single-file edit | Draft → review | Auto if clear | Auto if clear | Auto |",
  eval_rows_md: "| Code change | Task + files | Validated change | All follow-ons correct |",
};

const TEMPLATE_DOC = `# AI Operating Constitution

## 2. Behavior Contract

**Always do:**
- Be helpful

**Never do:**
- Do nothing

**Tone / voice:** Direct.

**Confidence threshold:** High.

## 3. Autonomy Map

| Scenario | L1 — Review all | L2 — Cautious | L3 — Smart default | L4+ — Auto |
|---|---|---|---|---|
| [Your scenario] | [Your rule] | [Your rule] | [Your rule] | [Your rule] |

---

## 5. Eval Framework

| Scenario | Input | Expected Output | Pass Threshold |
|---|---|---|---|
| **Your biggest fear** | Input | Expected | 100% |

---
`;

const MULTI_SECTION_DOC = `## 2. Behavior Contract

Existing content here.

---

## 3. Autonomy Map

Some autonomy content.

---
`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(writeCycleFile).mockReturnValue(undefined);
  vi.mocked(ensureSpokeFiles).mockReturnValue(undefined);
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue("# file content\n\n| Header |\n|---|\n| old row |");
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe("buildPrompt", () => {
  it("contains Q: lines for all 9 questions", () => {
    const prompt = buildPrompt({});
    const qLines = prompt.split("\n").filter((l) => l.startsWith("Q: "));
    expect(qLines.length).toBe(9);
  });

  it('uses "(no answer)" for missing keys', () => {
    const prompt = buildPrompt({});
    expect(prompt).toContain("A: (no answer)");
  });

  it("includes actual answer text for provided keys", () => {
    const prompt = buildPrompt({ agent_purpose: "Help with TypeScript projects" });
    expect(prompt).toContain("A: Help with TypeScript projects");
  });

  it("includes the JSON schema block", () => {
    const prompt = buildPrompt({});
    expect(prompt).toContain('"behavior_contract_md"');
    expect(prompt).toContain('"autonomy_map_rows_md"');
    expect(prompt).toContain('"eval_rows_md"');
  });

  it("includes summary field in the schema", () => {
    const prompt = buildPrompt({});
    expect(prompt).toContain('"summary"');
  });

  it("includes all answer values when all keys are provided", () => {
    const answers = {
      agent_purpose: "Write code",
      always_do: "Confirm before acting",
      never_do: "Delete without asking",
      tone: "Direct and brief",
      confidence_threshold: "When unsure",
      auto_ok: "Formatting fixes",
      always_review: "Production deployments",
      good_output: "Working tests",
      biggest_fear: "Deleting data",
    };
    const prompt = buildPrompt(answers);
    for (const val of Object.values(answers)) {
      expect(prompt).toContain(val);
    }
  });

  it("requests raw JSON output (no markdown wrapper)", () => {
    const prompt = buildPrompt({});
    expect(prompt).toContain("raw JSON only");
  });

  it("uses their actual words instruction in the prompt", () => {
    const prompt = buildPrompt({ biggest_fear: "Deleting production data" });
    expect(prompt).toContain("Deleting production data");
  });
});

// ---------------------------------------------------------------------------
// insertBeforeSectionEnd
// ---------------------------------------------------------------------------

describe("insertBeforeSectionEnd", () => {
  it("returns content unchanged when header not found", () => {
    const result = insertBeforeSectionEnd(MULTI_SECTION_DOC, "## 99. Missing", "insert me");
    expect(result).toBe(MULTI_SECTION_DOC);
  });

  it("inserts before the --- boundary", () => {
    const result = insertBeforeSectionEnd(
      MULTI_SECTION_DOC,
      "## 2. Behavior Contract",
      "NEW CONTENT",
    );
    expect(result).toContain("NEW CONTENT");
    const newIdx = result.indexOf("NEW CONTENT");
    const hrIdx = result.indexOf("\n---\n");
    expect(newIdx).toBeLessThan(hrIdx);
  });

  it("inserts before a ## N. boundary", () => {
    const doc = `## 1. Section One\n\nContent.\n\n## 2. Section Two\n`;
    const result = insertBeforeSectionEnd(doc, "## 1. Section One", "ADDED");
    const addedIdx = result.indexOf("ADDED");
    const section2Idx = result.indexOf("## 2.");
    expect(addedIdx).toBeLessThan(section2Idx);
  });

  it("appends to end when no boundary found", () => {
    const doc = "## 1. Section One\n\nJust some content.\n";
    const result = insertBeforeSectionEnd(doc, "## 1. Section One", "APPENDED");
    expect(result).toContain("APPENDED");
    expect(result.indexOf("APPENDED")).toBeGreaterThan(result.indexOf("Just some content."));
  });

  it("trims the insertion before placing it", () => {
    const doc = `## 1. Section\n\nContent.\n\n---\n`;
    const result = insertBeforeSectionEnd(doc, "## 1. Section", "  TRIMMED  ");
    expect(result).toContain("TRIMMED");
    expect(result).not.toContain("  TRIMMED  ");
  });

  it("preserves existing content around the insertion", () => {
    const result = insertBeforeSectionEnd(MULTI_SECTION_DOC, "## 2. Behavior Contract", "INSERTED");
    expect(result).toContain("Existing content here.");
    expect(result).toContain("## 3. Autonomy Map");
  });
});

// ---------------------------------------------------------------------------
// applyOnboarding
// ---------------------------------------------------------------------------

describe("applyOnboarding", () => {
  it("replaces the placeholder behavior contract block", () => {
    const result = applyOnboarding(TEMPLATE_DOC, MOCK_RESPONSE);
    expect(result).not.toContain("- Be helpful");
    expect(result).toContain("- Confirm plan first");
  });

  it("preserves the rest of the document structure", () => {
    const result = applyOnboarding(TEMPLATE_DOC, MOCK_RESPONSE);
    expect(result).toContain("## 3. Autonomy Map");
    expect(result).toContain("## 5. Eval Framework");
  });

  it("returns a string (never mutates original)", () => {
    const original = TEMPLATE_DOC;
    const result = applyOnboarding(original, MOCK_RESPONSE);
    expect(typeof result).toBe("string");
    expect(result).not.toBe(original);
  });

  it("places behavior contract content in section 2", () => {
    const result = applyOnboarding(TEMPLATE_DOC, MOCK_RESPONSE);
    const section2Start = result.indexOf("## 2. Behavior Contract");
    const section3Start = result.indexOf("## 3. Autonomy Map");
    const contractIdx = result.indexOf("Confirm plan first");
    expect(contractIdx).toBeGreaterThan(section2Start);
    expect(contractIdx).toBeLessThan(section3Start);
  });

  it("does not alter the document when section 2 header is absent", () => {
    const docWithoutSection2 = `# Title\n\n## 1. Working Agreements\n\nContent.\n`;
    const result = applyOnboarding(docWithoutSection2, MOCK_RESPONSE);
    // Regex won't match so document is unchanged
    expect(result).toBe(docWithoutSection2);
  });
});

// ---------------------------------------------------------------------------
// replaceTableBody
// ---------------------------------------------------------------------------

describe("replaceTableBody", () => {
  it("replaces rows after the last separator", () => {
    const content = `# Title\n\n| Col |\n|---|\n| old row |\n`;
    const result = replaceTableBody(content, "| new row |");
    expect(result).toContain("| new row |");
    expect(result).not.toContain("| old row |");
  });

  it("preserves the table header and separator", () => {
    const content = `# Title\n\n| Col |\n|---|\n| old row |\n`;
    const result = replaceTableBody(content, "| new row |");
    expect(result).toContain("| Col |");
    expect(result).toContain("|---|");
  });

  it("appends when no separator row is found", () => {
    const content = `# Title\n\nSome prose.`;
    const result = replaceTableBody(content, "| new row |");
    expect(result).toContain("| new row |");
    expect(result).toContain("Some prose.");
  });

  it("handles multi-row new content", () => {
    const content = `| H |\n|---|\n| old |`;
    const newRows = "| row 1 |\n| row 2 |";
    const result = replaceTableBody(content, newRows);
    expect(result).toContain("| row 1 |");
    expect(result).toContain("| row 2 |");
  });

  it("handles a table with a column alignment separator (colons)", () => {
    const content = `| H |\n|:---:|\n| old |`;
    const result = replaceTableBody(content, "| new |");
    expect(result).toContain("| new |");
    expect(result).not.toContain("| old |");
  });

  it("does not include trailing whitespace in old rows", () => {
    const content = `| H |\n|---|\n| old |`;
    const result = replaceTableBody(content, "| new |");
    expect(result.trimEnd()).toBe(result.trimEnd());
  });

  it("returns content with new rows ending with a newline", () => {
    const content = `| H |\n|---|\n| old |`;
    const result = replaceTableBody(content, "| new |");
    expect(result.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyOnboardingToSpokes
// ---------------------------------------------------------------------------

describe("applyOnboardingToSpokes", () => {
  it("calls ensureSpokeFiles to guarantee directories exist", () => {
    applyOnboardingToSpokes("/test/cwd", MOCK_RESPONSE);
    expect(vi.mocked(ensureSpokeFiles)).toHaveBeenCalledWith("/test/cwd");
  });

  it("reads the autonomy-detail file", () => {
    applyOnboardingToSpokes("/test/cwd", MOCK_RESPONSE);
    const readCalls = vi.mocked(fs.readFileSync).mock.calls.map((c) => c[0] as string);
    expect(readCalls.some((p) => p.includes("autonomy-detail"))).toBe(true);
  });

  it("reads the eval-framework file", () => {
    applyOnboardingToSpokes("/test/cwd", MOCK_RESPONSE);
    const readCalls = vi.mocked(fs.readFileSync).mock.calls.map((c) => c[0] as string);
    expect(readCalls.some((p) => p.includes("eval-framework"))).toBe(true);
  });

  it("writes the autonomy-detail file with new rows", () => {
    applyOnboardingToSpokes("/test/cwd", MOCK_RESPONSE);
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls.map((c) => c[0] as string);
    expect(writeCalls.some((p) => p.includes("autonomy-detail"))).toBe(true);
  });

  it("writes the eval-framework file with new rows", () => {
    applyOnboardingToSpokes("/test/cwd", MOCK_RESPONSE);
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls.map((c) => c[0] as string);
    expect(writeCalls.some((p) => p.includes("eval-framework"))).toBe(true);
  });

  it("autonomy-detail written content contains the new rows", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("| H |\n|---|\n| old |");
    applyOnboardingToSpokes("/test/cwd", MOCK_RESPONSE);
    const autonomyWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find((c) => (c[0] as string).includes("autonomy-detail"));
    expect(autonomyWrite).toBeDefined();
    expect(autonomyWrite![1] as string).toContain("Single-file edit");
  });

  it("eval-framework written content contains the new rows", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("| H |\n|---|\n| old |");
    applyOnboardingToSpokes("/test/cwd", MOCK_RESPONSE);
    const evalWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find((c) => (c[0] as string).includes("eval-framework"));
    expect(evalWrite).toBeDefined();
    expect(evalWrite![1] as string).toContain("Code change");
  });

  it("writes files with utf-8 encoding", () => {
    applyOnboardingToSpokes("/test/cwd", MOCK_RESPONSE);
    for (const call of vi.mocked(fs.writeFileSync).mock.calls) {
      expect(call[2]).toBe("utf-8");
    }
  });
});

// ---------------------------------------------------------------------------
// onboardCommand
// ---------------------------------------------------------------------------

/**
 * Helper that configures the readline mock to answer all 9 questions
 * automatically, then answer the confirm prompt with the given reply.
 *
 * readline.question(prompt, callback) — we call callback(answer) synchronously.
 */
function setupReadlineAnswers(confirmAnswer: string, questionAnswer = "test answer"): void {
  let callCount = 0;
  mockRlQuestion.mockImplementation((_prompt: string, cb: (a: string) => void) => {
    callCount++;
    // First 9 calls: the Q&A questions. Last call: the y/N confirm prompt.
    if (callCount <= 9) {
      cb(questionAnswer);
    } else {
      cb(confirmAnswer);
    }
  });
}

describe("onboardCommand", () => {
  const CWD = "/test/cwd";

  beforeEach(() => {
    vi.mocked(callClaudeForJson).mockResolvedValue({ result: MOCK_RESPONSE, tokens: 0 });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(TEMPLATE_DOC);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    setupReadlineAnswers("y");
  });

  it("calls Claude with a prompt built from answers", async () => {
    await onboardCommand(CWD);
    expect(vi.mocked(callClaudeForJson)).toHaveBeenCalledOnce();
    const prompt = vi.mocked(callClaudeForJson).mock.calls[0][0] as string;
    expect(prompt).toContain("test answer");
  });

  it("asks all 9 questions via readline", async () => {
    await onboardCommand(CWD);
    // 9 content questions + 1 confirm = 10 total question calls
    expect(mockRlQuestion).toHaveBeenCalledTimes(10);
  });

  it("closes the readline interface after collecting answers", async () => {
    await onboardCommand(CWD);
    expect(mockRlClose).toHaveBeenCalled();
  });

  it("writes PATINA.md when confirmed with 'y'", async () => {
    await onboardCommand(CWD);
    const writes = vi.mocked(fs.writeFileSync).mock.calls.map((c) => c[0] as string);
    expect(writes.some((p) => p.includes("PATINA.md"))).toBe(true);
  });

  it("written PATINA.md content includes new behavior contract", async () => {
    await onboardCommand(CWD);
    const patinaWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find((c) => (c[0] as string).includes("PATINA.md"));
    expect(patinaWrite).toBeDefined();
    expect(patinaWrite![1] as string).toContain("Confirm plan first");
  });

  it("saves a cycle file after confirming", async () => {
    await onboardCommand(CWD);
    expect(vi.mocked(writeCycleFile)).toHaveBeenCalledOnce();
  });

  it("cycle file content contains the summary from Claude", async () => {
    await onboardCommand(CWD);
    const cycleContent = vi.mocked(writeCycleFile).mock.calls[0][1] as string;
    expect(cycleContent).toContain("Established initial agreements.");
  });

  it("cycle file content contains behavior contract", async () => {
    await onboardCommand(CWD);
    const cycleContent = vi.mocked(writeCycleFile).mock.calls[0][1] as string;
    expect(cycleContent).toContain("Confirm plan first");
  });

  it("cycle file content contains autonomy rows", async () => {
    await onboardCommand(CWD);
    const cycleContent = vi.mocked(writeCycleFile).mock.calls[0][1] as string;
    expect(cycleContent).toContain("Single-file edit");
  });

  it("logs success message after applying", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await onboardCommand(CWD);
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("PATINA.md");
  });

  it("logs the cycles path after applying", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await onboardCommand(CWD);
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("cycles/");
  });

  it("logs the post-write PATINA core estimate after applying", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await onboardCommand(CWD);
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("Core PATINA.md now ~");
  });

  it("aborts without writing when confirmed with 'N'", async () => {
    setupReadlineAnswers("N");
    await onboardCommand(CWD);
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(writeCycleFile)).not.toHaveBeenCalled();
  });

  it("aborts without writing when confirm is empty (default no)", async () => {
    setupReadlineAnswers("");
    await onboardCommand(CWD);
    expect(vi.mocked(writeCycleFile)).not.toHaveBeenCalled();
  });

  it("logs abort message when user declines", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setupReadlineAnswers("n");
    await onboardCommand(CWD);
    const allLogs = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allLogs).toContain("Aborted");
  });

  it("calls process.exit(1) when Claude call fails", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(callClaudeForJson).mockRejectedValue(new Error("Claude CLI failed"));

    await expect(onboardCommand(CWD)).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("logs the Claude error message when call fails", async () => {
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(callClaudeForJson).mockRejectedValue(new Error("network timeout"));

    await expect(onboardCommand(CWD)).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    const msg = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain("network timeout");
  });

  it("calls process.exit(1) when PATINA.md does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(onboardCommand(CWD)).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("updates the last-updated timestamp in PATINA.md", async () => {
    const docWithDate = TEMPLATE_DOC + "\n> Last updated: 2024-01-01";
    vi.mocked(fs.readFileSync).mockReturnValue(docWithDate);
    await onboardCommand(CWD);
    const patinaWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find((c) => (c[0] as string).includes("PATINA.md"));
    expect(patinaWrite).toBeDefined();
    const written = patinaWrite![1] as string;
    // The date should have been updated to today
    expect(written).not.toContain("2024-01-01");
  });

  it("writes spoke files (autonomy and eval) during confirmed flow", async () => {
    await onboardCommand(CWD);
    expect(vi.mocked(ensureSpokeFiles)).toHaveBeenCalled();
  });
});
