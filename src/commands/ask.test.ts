import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Capture, Reflection } from "../lib/storage.js";

vi.mock("../lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage.js")>();
  return {
    ...actual,
    assertInitialised: vi.fn(),
    getLatestCycleDate: vi.fn(),
    readCaptures: vi.fn(),
    readReflections: vi.fn(),
    writeReflection: vi.fn(),
  };
});

vi.mock("../lib/questions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/questions.js")>();
  return {
    ...actual,
    loadQuestions: vi.fn(),
  };
});

vi.mock("../lib/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/git.js")>();
  return {
    ...actual,
    getGitAuthor: vi.fn(),
  };
});

import { askCommand } from "./ask.js";
import {
  assertInitialised,
  getLatestCycleDate,
  readCaptures,
  readReflections,
} from "../lib/storage.js";
import { loadQuestions } from "../lib/questions.js";
import { getGitAuthor } from "../lib/git.js";

function makeCapture(index: number, overrides: Partial<Capture> = {}): Capture {
  return {
    id: `capture-${index}`,
    text: `capture text ${index}`,
    author: "Leo",
    timestamp: `2026-01-${String(index).padStart(2, "0")}T09:00:00Z`,
    ...overrides,
  };
}

describe("askCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(assertInitialised).mockReturnValue(undefined);
    vi.mocked(getLatestCycleDate).mockReturnValue("2026-01-01");
    vi.mocked(readReflections).mockReturnValue([] as Reflection[]);
    vi.mocked(loadQuestions).mockReturnValue([
      { key: "overall_feel", text: "How did this cycle feel overall?" },
    ]);
    vi.mocked(getGitAuthor).mockReturnValue("Leo");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns up to 10 recent captures and captureCount in --json --show output", async () => {
    const captures = Array.from({ length: 12 }, (_, i) =>
      makeCapture(i + 1, { tag: i === 2 ? undefined : "pattern" }),
    );
    vi.mocked(readCaptures).mockReturnValue(captures);

    await askCommand({ json: true, show: true });

    expect(console.log).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]));

    expect(payload.ok).toBe(true);
    expect(payload.captures).toHaveLength(10);
    expect(payload.captureCount).toBe(12);
    expect(payload.captures[0].id).toBe("capture-3");
    expect(payload.captures[9].id).toBe("capture-12");
    expect(payload.captures[0].tag).toBeNull();
  });
});
