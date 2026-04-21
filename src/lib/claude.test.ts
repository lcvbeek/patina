import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

// ---------------------------------------------------------------------------
// Module-level mock for child_process
// ---------------------------------------------------------------------------

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn(), spawnSync: vi.fn() };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake ChildProcess that emits stdout/stderr/close events in order.
 * `exitCode` of 0 = success. Pass stdoutData to control what stdout yields.
 */
function makeChildProcess(options: {
  exitCode: number;
  stdoutData?: string;
  stderrData?: string;
}): ChildProcess {
  const child = new EventEmitter() as ChildProcess;

  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinEmitter = new EventEmitter() as NodeJS.WritableStream;

  // Minimal writable stream interface for stdin
  stdinEmitter.write = vi.fn().mockReturnValue(true);
  stdinEmitter.end = vi.fn().mockImplementation(() => {
    // Emit events asynchronously so listeners are registered first
    setImmediate(() => {
      if (options.stdoutData) {
        stdoutEmitter.emit("data", Buffer.from(options.stdoutData, "utf8"));
      }
      if (options.stderrData) {
        stderrEmitter.emit("data", Buffer.from(options.stderrData, "utf8"));
      }
      child.emit("close", options.exitCode);
    });
    return stdinEmitter;
  });

  (child as unknown as Record<string, unknown>).stdout = stdoutEmitter;
  (child as unknown as Record<string, unknown>).stderr = stderrEmitter;
  (child as unknown as Record<string, unknown>).stdin = stdinEmitter;

  return child;
}

// ---------------------------------------------------------------------------
// callClaudeForText / callClaudeForJson (both delegate through callViaCli when
// the CLI is available)
// ---------------------------------------------------------------------------

describe("callViaCli (via callClaudeForText)", () => {
  let spawnMock: ReturnType<typeof vi.fn>;
  let spawnSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import("child_process");
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>;
    spawnSyncMock = cp.spawnSync as unknown as ReturnType<typeof vi.fn>;

    // Default: CLI is available
    spawnSyncMock.mockReturnValue({ error: null, status: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("resolves with trimmed stdout on exit code 0", async () => {
    spawnSyncMock.mockReturnValue({ error: null, status: 0 });
    spawnMock.mockReturnValue(makeChildProcess({ exitCode: 0, stdoutData: "  hello world  \n" }));

    vi.resetModules();
    const { callClaudeForText } = await import("./claude.js");
    const result = await callClaudeForText("test prompt");

    expect(result).toBe("hello world");
  });

  it("delivers the prompt to stdin", async () => {
    spawnSyncMock.mockReturnValue({ error: null, status: 0 });
    const child = makeChildProcess({ exitCode: 0, stdoutData: "response" });
    spawnMock.mockReturnValue(child);

    vi.resetModules();
    const { callClaudeForText } = await import("./claude.js");
    await callClaudeForText("my prompt text");

    expect(child.stdin!.write).toHaveBeenCalledWith("my prompt text", "utf8");
    expect(child.stdin!.end).toHaveBeenCalled();
  });

  it("spawns claude with the expected arguments", async () => {
    spawnSyncMock.mockReturnValue({ error: null, status: 0 });
    spawnMock.mockReturnValue(makeChildProcess({ exitCode: 0, stdoutData: "ok" }));

    vi.resetModules();
    const { callClaudeForText } = await import("./claude.js");
    await callClaudeForText("prompt");

    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["-p", "--output-format", "text", "--model", "sonnet"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  it("rejects with stderr message on non-zero exit code", async () => {
    spawnSyncMock.mockReturnValue({ error: null, status: 0 });
    spawnMock.mockReturnValue(
      makeChildProcess({ exitCode: 1, stderrData: "Authentication required" }),
    );

    vi.resetModules();
    const { callClaudeForText } = await import("./claude.js");
    await expect(callClaudeForText("prompt")).rejects.toThrow("Authentication required");
  });

  it("rejects with a fallback message when non-zero exit has no stderr", async () => {
    spawnSyncMock.mockReturnValue({ error: null, status: 0 });
    spawnMock.mockReturnValue(makeChildProcess({ exitCode: 2, stderrData: "" }));

    vi.resetModules();
    const { callClaudeForText } = await import("./claude.js");
    await expect(callClaudeForText("prompt")).rejects.toThrow(
      "Claude CLI exited with non-zero status",
    );
  });

  it("rejects when the spawn itself errors (e.g. command not found)", async () => {
    spawnSyncMock.mockReturnValue({ error: null, status: 0 });
    const child = makeChildProcess({ exitCode: 0 });

    // Override end to emit an 'error' event instead of close
    child.stdin!.end = vi.fn().mockImplementation(() => {
      setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
      return child.stdin;
    });

    spawnMock.mockReturnValue(child);

    vi.resetModules();
    const { callClaudeForText } = await import("./claude.js");
    await expect(callClaudeForText("prompt")).rejects.toThrow("spawn ENOENT");
  });
});

// ---------------------------------------------------------------------------
// callClaudeForJson
// ---------------------------------------------------------------------------

describe("callClaudeForJson", () => {
  let spawnMock: ReturnType<typeof vi.fn>;
  let spawnSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import("child_process");
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>;
    spawnSyncMock = cp.spawnSync as unknown as ReturnType<typeof vi.fn>;
    spawnSyncMock.mockReturnValue({ error: null, status: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("parses and returns valid JSON from CLI output", async () => {
    spawnMock.mockReturnValue(makeChildProcess({ exitCode: 0, stdoutData: '{"key": "value"}' }));
    vi.resetModules();
    const { callClaudeForJson } = await import("./claude.js");
    const result = await callClaudeForJson<{ key: string }>("prompt");
    expect(result).toEqual({ key: "value" });
  });

  it("strips JSON code fences before parsing", async () => {
    spawnMock.mockReturnValue(
      makeChildProcess({ exitCode: 0, stdoutData: '```json\n{"n": 1}\n```' }),
    );
    vi.resetModules();
    const { callClaudeForJson } = await import("./claude.js");
    const result = await callClaudeForJson<{ n: number }>("prompt");
    expect(result).toEqual({ n: 1 });
  });

  it("strips plain code fences (no language tag) before parsing", async () => {
    spawnMock.mockReturnValue(
      makeChildProcess({ exitCode: 0, stdoutData: '```\n{"x": true}\n```' }),
    );
    vi.resetModules();
    const { callClaudeForJson } = await import("./claude.js");
    const result = await callClaudeForJson<{ x: boolean }>("prompt");
    expect(result).toEqual({ x: true });
  });

  it("extracts JSON when Claude prefixes it with prose", async () => {
    spawnMock.mockReturnValue(
      makeChildProcess({
        exitCode: 0,
        stdoutData: 'Here is my analysis.\n\n```json\n{"insight": "test"}\n```',
      }),
    );
    vi.resetModules();
    const { callClaudeForJson } = await import("./claude.js");
    const result = await callClaudeForJson<{ insight: string }>("prompt");
    expect(result).toEqual({ insight: "test" });
  });

  it("throws a descriptive error for invalid JSON responses", async () => {
    spawnMock.mockReturnValue(
      makeChildProcess({ exitCode: 0, stdoutData: "This is not JSON at all." }),
    );
    vi.resetModules();
    const { callClaudeForJson } = await import("./claude.js");
    await expect(callClaudeForJson("prompt")).rejects.toThrow(
      "Could not parse Claude response as JSON",
    );
  });

  it("includes a snippet of the raw response in the parse error", async () => {
    const rawResponse = "I cannot complete this request.";
    spawnMock.mockReturnValue(makeChildProcess({ exitCode: 0, stdoutData: rawResponse }));
    vi.resetModules();
    const { callClaudeForJson } = await import("./claude.js");
    await expect(callClaudeForJson("prompt")).rejects.toThrow(rawResponse);
  });

  it("throws for empty response", async () => {
    spawnMock.mockReturnValue(makeChildProcess({ exitCode: 0, stdoutData: "" }));
    vi.resetModules();
    const { callClaudeForJson } = await import("./claude.js");
    await expect(callClaudeForJson("prompt")).rejects.toThrow(
      "Could not parse Claude response as JSON",
    );
  });
});

// ---------------------------------------------------------------------------
// callClaude fallback: no CLI available, no API key
// ---------------------------------------------------------------------------

describe("callClaude — no access path available", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("throws a user-friendly error when neither CLI nor API key is available", async () => {
    const cp = await import("child_process");
    const spawnSyncMock = cp.spawnSync as unknown as ReturnType<typeof vi.fn>;
    spawnSyncMock.mockReturnValue({ error: new Error("not found"), status: null });

    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();

    const { callClaudeForText } = await import("./claude.js");
    await expect(callClaudeForText("prompt")).rejects.toThrow("No Claude access found");
  });
});

// ---------------------------------------------------------------------------
// ANALYST_PREAMBLE and patinaMdEditingRules — exported constants / functions
// ---------------------------------------------------------------------------

describe("ANALYST_PREAMBLE", () => {
  let ANALYST_PREAMBLE: string;

  beforeEach(async () => {
    vi.resetModules();
    ({ ANALYST_PREAMBLE } = await import("./claude.js"));
  });

  it("is a non-empty string", () => {
    expect(typeof ANALYST_PREAMBLE).toBe("string");
    expect(ANALYST_PREAMBLE.length).toBeGreaterThan(0);
  });

  it("references behavioral pattern analysis", () => {
    expect(ANALYST_PREAMBLE).toContain("behavioral pattern");
  });
});

describe("patinaMdEditingRules", () => {
  let patinaMdEditingRules: (maxLines: number, maxChars: number) => string;

  beforeEach(async () => {
    vi.resetModules();
    ({ patinaMdEditingRules } = await import("./claude.js"));
  });

  it("returns a string containing the provided line and char limits", () => {
    const rules = patinaMdEditingRules(80, 3200);
    expect(rules).toContain("80");
    expect(rules).toContain("3200");
  });

  it("mentions the three diff action types", () => {
    const rules = patinaMdEditingRules(80, 3200);
    expect(rules).toContain('"add"');
    expect(rules).toContain('"replace"');
    expect(rules).toContain('"remove"');
  });
});
