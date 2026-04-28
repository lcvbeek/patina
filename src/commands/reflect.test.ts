import { describe, it, expect } from "vitest";
import { formatCapturesForDisplay } from "./reflect.js";
import type { Capture } from "../lib/storage.js";

function makeCapture(index: number, overrides: Partial<Capture> = {}): Capture {
  const day = String(index).padStart(2, "0");
  return {
    id: `capture-${index}`,
    text: `capture ${index}`,
    author: "Leo",
    timestamp: `2026-01-${day}T12:00:00Z`,
    ...overrides,
  };
}

describe("formatCapturesForDisplay", () => {
  it("shows the most recent captures and an older-count line when truncated", () => {
    const captures = Array.from({ length: 12 }, (_, i) => makeCapture(i + 1));

    const lines = formatCapturesForDisplay(captures, 10);

    expect(lines).toHaveLength(11);
    expect(lines[0]).toContain("2 older captures not shown");
    expect(lines[1]).toContain("2026-01-03");
    expect(lines[10]).toContain("2026-01-12");
  });

  it("truncates long capture text and appends an ellipsis", () => {
    const longText = "x".repeat(130);

    const lines = formatCapturesForDisplay(
      [makeCapture(1, { text: longText, tag: "pattern" })],
      10,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("- 2026-01-01 [pattern]: ");
    const renderedText = lines[0].split(": ")[1];
    expect(renderedText).toHaveLength(118);
    expect(renderedText.endsWith("…")).toBe(true);
  });
});
