import { describe, it, expect } from "vitest";
import { buildPrompt, insertBeforeSectionEnd, applyOnboarding } from "./onboard.js";
import type { OnboardingResponse } from "./onboard.js";

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
});

// ---------------------------------------------------------------------------
// insertBeforeSectionEnd
// ---------------------------------------------------------------------------

const MULTI_SECTION_DOC = `## 2. Behavior Contract

Existing content here.

---

## 3. Autonomy Map

Some autonomy content.

---
`;

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
});

// ---------------------------------------------------------------------------
// applyOnboarding
// ---------------------------------------------------------------------------

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

const MOCK_RESPONSE: OnboardingResponse = {
  summary: "Established initial agreements.",
  behavior_contract_md: `**Always do:**\n\n- Confirm plan first\n\n**Never do:**\n\n- Push without approval\n\n**Tone:** Direct and brief.\n\n**Stop and ask before:** Destructive operations.`,
  autonomy_map_rows_md:
    "| Single-file edit | Draft → review | Auto if clear | Auto if clear | Auto |",
  eval_rows_md: "| Code change | Task + files | Validated change | All follow-ons correct |",
};

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
});
