import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectRework,
  extractTextFromContent,
  extractToolName,
  parseConversationFile,
} from "./parser.js";

// ---------------------------------------------------------------------------
// detectRework
// ---------------------------------------------------------------------------

describe("detectRework", () => {
  it('matches "let me try again"', () => {
    expect(detectRework("Let me try again with a different approach.")).toBe(true);
  });

  it('matches "actually,"', () => {
    expect(detectRework("Actually, that was wrong.")).toBe(true);
  });

  it('matches "i made a mistake"', () => {
    expect(detectRework("I made a mistake in the previous step.")).toBe(true);
  });

  it('matches "i was wrong"', () => {
    expect(detectRework("I was wrong about that.")).toBe(true);
  });

  it('matches "apologies,"', () => {
    expect(detectRework("Apologies, let me correct that.")).toBe(true);
  });

  it('matches "i apologize"', () => {
    expect(detectRework("I apologize for the confusion.")).toBe(true);
  });

  it('matches "i apologise" (British spelling)', () => {
    expect(detectRework("I apologise for the error.")).toBe(true);
  });

  it('matches "let me reconsider"', () => {
    expect(detectRework("Let me reconsider this approach.")).toBe(true);
  });

  it('matches "i need to correct"', () => {
    expect(detectRework("I need to correct my earlier answer.")).toBe(true);
  });

  it('matches "i got that wrong"', () => {
    expect(detectRework("I got that wrong.")).toBe(true);
  });

  it('matches "that was incorrect"', () => {
    expect(detectRework("That was incorrect.")).toBe(true);
  });

  it('matches "allow me to redo"', () => {
    expect(detectRework("Allow me to redo this.")).toBe(true);
  });

  it('matches "let me redo"', () => {
    expect(detectRework("Let me redo that step.")).toBe(true);
  });

  it('matches "i misunderstood"', () => {
    expect(detectRework("I misunderstood the requirement.")).toBe(true);
  });

  it('matches "i overlooked"', () => {
    expect(detectRework("I overlooked that edge case.")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(detectRework("ACTUALLY, I was wrong.")).toBe(true);
  });

  it("returns false for unrelated text", () => {
    expect(detectRework("Here is the implementation you requested.")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(detectRework("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractTextFromContent
// ---------------------------------------------------------------------------

describe("extractTextFromContent", () => {
  it("returns string input unchanged", () => {
    expect(extractTextFromContent("hello world")).toBe("hello world");
  });

  it("returns empty string for null", () => {
    expect(extractTextFromContent(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(extractTextFromContent(undefined)).toBe("");
  });

  it("joins text blocks from an array", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(extractTextFromContent(content)).toBe("hello world");
  });

  it("ignores non-text blocks", () => {
    const content = [
      { type: "tool_use", name: "Read", input: {} },
      { type: "text", text: "result" },
    ];
    expect(extractTextFromContent(content)).toBe(" result");
  });

  it("handles a block missing the text field", () => {
    const content = [{ type: "text" }];
    expect(extractTextFromContent(content)).toBe("");
  });

  it("returns empty string for an empty array", () => {
    expect(extractTextFromContent([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractToolName
// ---------------------------------------------------------------------------

describe("extractToolName", () => {
  it("returns empty array for non-array input (string)", () => {
    expect(extractToolName("not an array")).toEqual([]);
  });

  it("returns empty array for null", () => {
    expect(extractToolName(null)).toEqual([]);
  });

  it("extracts a single tool_use name", () => {
    const content = [{ type: "tool_use", name: "Read" }];
    expect(extractToolName(content)).toEqual(["Read"]);
  });

  it("extracts multiple tool names in order", () => {
    const content = [
      { type: "tool_use", name: "Read" },
      { type: "tool_use", name: "Edit" },
    ];
    expect(extractToolName(content)).toEqual(["Read", "Edit"]);
  });

  it("filters out non-tool_use blocks", () => {
    const content = [
      { type: "text", text: "some text" },
      { type: "tool_use", name: "Bash" },
    ];
    expect(extractToolName(content)).toEqual(["Bash"]);
  });

  it("skips tool_use blocks missing a name", () => {
    const content = [{ type: "tool_use" }, { type: "tool_use", name: "Write" }];
    expect(extractToolName(content)).toEqual(["Write"]);
  });

  it("returns empty array for an empty array", () => {
    expect(extractToolName([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseConversationFile (uses tmp files)
// ---------------------------------------------------------------------------

describe("parseConversationFile", () => {
  let tmpFile: string;

  afterEach(() => {
    if (tmpFile) {
      try {
        unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  });

  function writeTmp(lines: object[]): string {
    tmpFile = join(
      tmpdir(),
      `patina-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    writeFileSync(tmpFile, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
    return tmpFile;
  }

  it("returns empty array for an empty file", () => {
    tmpFile = join(tmpdir(), `patina-test-empty-${Date.now()}.jsonl`);
    writeFileSync(tmpFile, "", "utf-8");
    expect(parseConversationFile(tmpFile, "proj")).toEqual([]);
  });

  it("parses a single session from one sessionId", () => {
    const file = writeTmp([
      {
        type: "message",
        sessionId: "abc-123",
        timestamp: "2025-01-01T00:00:00Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        sessionId: "abc-123",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    const sessions = parseConversationFile(file, "my-project");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe("abc-123");
    expect(sessions[0].project).toBe("my-project");
    expect(sessions[0].turn_count).toBe(2);
  });

  it("groups multiple sessionIds into separate sessions", () => {
    const file = writeTmp([
      { type: "message", sessionId: "session-A", message: { role: "user", content: "hello" } },
      { type: "message", sessionId: "session-B", message: { role: "user", content: "hi" } },
    ]);
    const sessions = parseConversationFile(file, "proj");
    expect(sessions).toHaveLength(2);
  });

  it("sets had_rework true when assistant message contains a rework phrase", () => {
    const file = writeTmp([
      {
        type: "message",
        sessionId: "s1",
        message: { role: "assistant", content: "Actually, I was wrong about that." },
      },
    ]);
    const [session] = parseConversationFile(file, "proj");
    expect(session.had_rework).toBe(true);
  });

  it("counts tool calls in assistant messages", () => {
    const file = writeTmp([
      {
        type: "message",
        sessionId: "s1",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read" },
            { type: "tool_use", name: "Read" },
            { type: "tool_use", name: "Edit" },
          ],
        },
      },
    ]);
    const [session] = parseConversationFile(file, "proj");
    expect(session.tool_calls["Read"]).toBe(2);
    expect(session.tool_calls["Edit"]).toBe(1);
  });

  it("skips malformed JSONL lines and parses valid ones", () => {
    tmpFile = join(tmpdir(), `patina-test-malformed-${Date.now()}.jsonl`);
    writeFileSync(
      tmpFile,
      [
        "not valid json{{{",
        JSON.stringify({
          type: "message",
          sessionId: "ok",
          message: { role: "user", content: "hi" },
        }),
      ].join("\n"),
      "utf-8",
    );
    const sessions = parseConversationFile(tmpFile, "proj");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe("ok");
  });

  it("estimates tokens as ceil(char_count / 4.5) matching Anthropic's heuristic", () => {
    // 45 chars of content → 10 tokens
    const content = "a".repeat(45);
    const file = writeTmp([
      { type: "message", sessionId: "s1", message: { role: "user", content } },
    ]);
    const [session] = parseConversationFile(file, "proj");
    expect(session.estimated_tokens).toBe(Math.ceil(45 / 4.5));
  });

  it("accumulates real API token usage from assistant messages", () => {
    const file = writeTmp([
      {
        type: "message",
        sessionId: "s1",
        message: {
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 20000,
          },
        },
      },
      {
        type: "message",
        sessionId: "s1",
        message: {
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 200,
            output_tokens: 80,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 25000,
          },
        },
      },
    ]);
    const [session] = parseConversationFile(file, "proj");
    expect(session.actualTokens).toEqual({
      input: 300,
      output: 130,
      cacheCreation: 5000,
      cacheRead: 45000,
    });
  });

  it("leaves actualTokens undefined when no usage fields are present", () => {
    const file = writeTmp([
      { type: "message", sessionId: "s1", message: { role: "user", content: "hi" } },
      { type: "message", sessionId: "s1", message: { role: "assistant", content: "ok" } },
    ]);
    const [session] = parseConversationFile(file, "proj");
    expect(session.actualTokens).toBeUndefined();
  });

  it("attaches contextSnapshot when MCP and usage data are present", () => {
    const file = writeTmp([
      {
        type: "attachment",
        attachment: {
          type: "mcp_instructions_delta",
          addedNames: ["computer-use"],
        },
      },
      {
        type: "message",
        sessionId: "s1",
        message: {
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 30000,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
    ]);
    const [session] = parseConversationFile(file, "proj");
    expect(session.contextSnapshot).toBeDefined();
    expect(session.contextSnapshot!.mcpServers).toEqual(["computer-use"]);
    expect(session.contextSnapshot!.systemPromptTokens).toBe(30000);
  });
});
