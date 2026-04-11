import { describe, it, expect } from "vitest";
import { generateId, buildSynthesisPrompt } from "./capture.js";
import { getGitAuthor } from "../lib/git.js";
import type { Capture } from "../lib/storage.js";

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
    // Format: YYYY-MM-DDTHH-MM-SS-mmmZ-xxxx
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{4}$/);
  });

  it("produces different suffixes across calls (probabilistic)", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const ids = new Set(Array.from({ length: 10 }, () => generateId(now)));
    // With 36^4 = ~1.7M possibilities, 10 calls should almost always be unique
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe("getGitAuthor", () => {
  it("returns a non-empty string in a git repo", () => {
    // We are running in a git repo (patina itself), so git config user.name should work.
    const author = getGitAuthor();
    expect(typeof author).toBe("string");
    expect(author.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildSynthesisPrompt
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
});
