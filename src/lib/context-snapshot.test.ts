import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractContextSnapshot,
  modelContextWindow,
  systemPromptSizeLabel,
} from "./context-snapshot.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpFile: string | null = null;

function writeTmpJsonl(lines: object[]): string {
  const filePath = join(tmpdir(), `patina-ctx-test-${Date.now()}.jsonl`);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  tmpFile = filePath;
  return filePath;
}

afterEach(() => {
  if (tmpFile) {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore
    }
    tmpFile = null;
  }
});

// ---------------------------------------------------------------------------
// extractContextSnapshot
// ---------------------------------------------------------------------------

describe("extractContextSnapshot", () => {
  it("returns zeroed snapshot for empty file", () => {
    const filePath = writeTmpJsonl([]);
    const snap = extractContextSnapshot(filePath);
    expect(snap.systemPromptTokens).toBe(0);
    expect(snap.mcpServers).toEqual([]);
    expect(snap.deferredTools).toEqual([]);
  });

  it("returns zeroed snapshot for non-existent file", () => {
    const snap = extractContextSnapshot("/tmp/does-not-exist-patina.jsonl");
    expect(snap.systemPromptTokens).toBe(0);
    expect(snap.mcpServers).toEqual([]);
    expect(snap.deferredTools).toEqual([]);
  });

  it("extracts MCP server names from mcp_instructions_delta attachments", () => {
    const filePath = writeTmpJsonl([
      { type: "permission-mode", permissionMode: "bypassPermissions" },
      {
        type: "attachment",
        attachment: {
          type: "mcp_instructions_delta",
          addedNames: ["computer-use", "plugin:everything-claude-code:context7"],
        },
      },
    ]);
    const snap = extractContextSnapshot(filePath);
    expect(snap.mcpServers).toEqual(["computer-use", "plugin:everything-claude-code:context7"]);
  });

  it("extracts deferred tool names from deferred_tools_delta attachments", () => {
    const filePath = writeTmpJsonl([
      {
        type: "attachment",
        attachment: {
          type: "deferred_tools_delta",
          addedNames: ["AskUserQuestion", "CronCreate", "EnterPlanMode"],
        },
      },
    ]);
    const snap = extractContextSnapshot(filePath);
    expect(snap.deferredTools).toEqual(["AskUserQuestion", "CronCreate", "EnterPlanMode"]);
  });

  it("extracts system prompt token cost from first assistant usage", () => {
    const filePath = writeTmpJsonl([
      { type: "permission-mode", permissionMode: "default" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 30080,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
    ]);
    const snap = extractContextSnapshot(filePath);
    expect(snap.systemPromptTokens).toBe(30080);
  });

  it("deduplicates repeated MCP server names", () => {
    const filePath = writeTmpJsonl([
      {
        type: "attachment",
        attachment: {
          type: "mcp_instructions_delta",
          addedNames: ["computer-use"],
        },
      },
      {
        type: "attachment",
        attachment: {
          type: "mcp_instructions_delta",
          addedNames: ["computer-use", "new-server"],
        },
      },
    ]);
    const snap = extractContextSnapshot(filePath);
    expect(snap.mcpServers).toEqual(["computer-use", "new-server"]);
  });

  it("extracts all three fields from a realistic session preamble", () => {
    const filePath = writeTmpJsonl([
      { type: "permission-mode", permissionMode: "bypassPermissions" },
      {
        type: "attachment",
        attachment: {
          type: "deferred_tools_delta",
          addedNames: ["AskUserQuestion", "CronCreate"],
        },
      },
      {
        type: "attachment",
        attachment: {
          type: "mcp_instructions_delta",
          addedNames: ["computer-use"],
        },
      },
      {
        type: "user",
        message: { role: "user", content: "hello" },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi!" }],
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 28000,
            cache_read_input_tokens: 0,
            output_tokens: 10,
          },
        },
      },
    ]);
    const snap = extractContextSnapshot(filePath);
    expect(snap.systemPromptTokens).toBe(28000);
    expect(snap.mcpServers).toEqual(["computer-use"]);
    expect(snap.deferredTools).toEqual(["AskUserQuestion", "CronCreate"]);
  });

  it("ignores zero cache_creation_input_tokens and reads the first non-zero value", () => {
    const filePath = writeTmpJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: 3, cache_creation_input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: 5, cache_creation_input_tokens: 15000, output_tokens: 20 },
        },
      },
    ]);
    const snap = extractContextSnapshot(filePath);
    expect(snap.systemPromptTokens).toBe(15000);
  });

  it("extracts model name from first assistant message with cache_creation tokens", () => {
    const filePath = writeTmpJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          usage: { input_tokens: 3, cache_creation_input_tokens: 30000, output_tokens: 0 },
        },
      },
    ]);
    const snap = extractContextSnapshot(filePath);
    expect(snap.model).toBe("claude-sonnet-4-6");
  });

  it("handles malformed JSON lines gracefully", () => {
    const filePath = join(tmpdir(), `patina-ctx-bad-${Date.now()}.jsonl`);
    writeFileSync(
      filePath,
      [
        "not valid json",
        JSON.stringify({
          type: "attachment",
          attachment: { type: "mcp_instructions_delta", addedNames: ["my-server"] },
        }),
        "{ broken",
      ].join("\n"),
      "utf-8",
    );
    tmpFile = filePath;
    const snap = extractContextSnapshot(filePath);
    expect(snap.mcpServers).toEqual(["my-server"]);
  });
});

// ---------------------------------------------------------------------------
// modelContextWindow
// ---------------------------------------------------------------------------

describe("modelContextWindow", () => {
  it("returns 1_000_000 for claude-sonnet-4-6", () => {
    expect(modelContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
  });

  it("returns 1_000_000 for claude-opus-4-6", () => {
    expect(modelContextWindow("claude-opus-4-6")).toBe(1_000_000);
  });

  it("returns 200_000 for claude-opus-4-5", () => {
    expect(modelContextWindow("claude-opus-4-5")).toBe(200_000);
  });

  it("returns 200_000 for claude-haiku-4-5", () => {
    expect(modelContextWindow("claude-haiku-4-5")).toBe(200_000);
  });

  it("returns 200_000 for claude-3-5-sonnet variant", () => {
    expect(modelContextWindow("claude-3-5-sonnet-20241022")).toBe(200_000);
  });

  it("returns undefined for unknown model", () => {
    expect(modelContextWindow("claude-unknown-99")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(modelContextWindow(undefined)).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(modelContextWindow("Claude-Sonnet-4-6")).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// systemPromptSizeLabel
// ---------------------------------------------------------------------------

describe("systemPromptSizeLabel", () => {
  it("classifies small prompts as Lean", () => {
    expect(systemPromptSizeLabel(2_000, 200_000)).toBe("Lean");
  });

  it("classifies 10k on 200k window as Moderate", () => {
    expect(systemPromptSizeLabel(10_000, 200_000)).toBe("Moderate");
  });

  it("classifies 25k on 200k window as Full", () => {
    expect(systemPromptSizeLabel(25_000, 200_000)).toBe("Full");
  });

  it("classifies 60k as Very heavy on 1M window (absolute dominates)", () => {
    expect(systemPromptSizeLabel(60_000, 1_000_000)).toBe("Very heavy");
  });

  it("classifies 30k on 200k window as Heavy (percentage dominates)", () => {
    expect(systemPromptSizeLabel(30_000, 200_000)).toBe("Heavy");
  });

  it("falls back to absolute-only when window size is undefined", () => {
    expect(systemPromptSizeLabel(60_000, undefined)).toBe("Very heavy");
    expect(systemPromptSizeLabel(2_000, undefined)).toBe("Lean");
  });

  it("takes the worse of absolute and percentage labels", () => {
    // 20k on 200k = 10% → Full by pct; 20k absolute → Full; both agree
    expect(systemPromptSizeLabel(20_000, 200_000)).toBe("Full");
    // 20k on 1M = 2% → Lean by pct; 20k absolute → Full; absolute wins
    expect(systemPromptSizeLabel(20_000, 1_000_000)).toBe("Full");
  });
});
