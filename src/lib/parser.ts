import fs from "fs";
import os from "os";
import path from "path";
import { z } from "zod";
import type { SessionSummary } from "./storage.js";
import { extractContextSnapshot, type ContextSnapshot } from "./context-snapshot.js";

// ---------------------------------------------------------------------------
// Claude Code JSONL message schema (permissive — we only extract what we need)
// ---------------------------------------------------------------------------

// Each line in a Claude Code conversation file is one of these entry types.
const MessageEntrySchema = z.object({
  type: z.string(),
  uuid: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  message: z
    .object({
      role: z.enum(["user", "assistant"]).optional(),
      content: z
        .union([
          z.string(),
          z.array(
            z.union([
              z.object({
                type: z.string(),
                text: z.string().optional(),
                name: z.string().optional(),
                input: z.unknown().optional(),
              }),
              z.unknown(),
            ]),
          ),
        ])
        .optional(),
      usage: z
        .object({
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          cache_creation_input_tokens: z.number().optional(),
          cache_read_input_tokens: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  // Some entries use a top-level content array (e.g. tool_result lines)
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
});

type MessageEntry = z.infer<typeof MessageEntrySchema>;

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

// Phrases that suggest the assistant is correcting itself
const REWORK_PHRASES = [
  /let me try again/i,
  /actually[,\s]/i,
  /i made a mistake/i,
  /i was wrong/i,
  /apologies[,\s]/i,
  /i apologise/i,
  /i apologize/i,
  /let me reconsider/i,
  /i need to correct/i,
  /i got that wrong/i,
  /that was incorrect/i,
  /allow me to redo/i,
  /let me redo/i,
  /i misunderstood/i,
  /i overlooked/i,
];

export function detectRework(text: string): boolean {
  return REWORK_PHRASES.some((re) => re.test(text));
}

export function extractTextFromContent(content: string | unknown[] | null | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as { type: string }).type === "text" &&
          "text" in block
        ) {
          return (block as { text: string }).text ?? "";
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

export function extractToolName(content: string | unknown[] | null | undefined): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: string }).type === "tool_use" &&
      "name" in block
    ) {
      names.push((block as { name: string }).name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

function parseJsonlFile(filePath: string): MessageEntry[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const entries: MessageEntry[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const result = MessageEntrySchema.safeParse(parsed);
      if (result.success) {
        entries.push(result.data);
      }
      // Silently skip lines that don't match — real logs have metadata entries too
    } catch {
      // Malformed JSON line — skip
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Session extraction
// ---------------------------------------------------------------------------

export interface ParsedSession {
  session_id: string;
  project: string;
  timestamp: string;
  turn_count: number;
  estimated_tokens: number;
  tool_calls: Record<string, number>;
  had_rework: boolean;
  /** Real API token counts from JSONL usage fields (undefined for pre-usage sessions). */
  actualTokens?: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  /** Context loaded at session start: system prompt size, MCP servers, deferred tools. */
  contextSnapshot?: ContextSnapshot;
}

/**
 * Parse a single JSONL conversation file and return one ParsedSession per
 * unique sessionId found. Claude Code can store multiple sessions in the same
 * file, so we group by sessionId.
 */
export function parseConversationFile(filePath: string, projectName: string): ParsedSession[] {
  const entries = parseJsonlFile(filePath);

  // Group entries by sessionId
  const bySession = new Map<string, MessageEntry[]>();

  for (const entry of entries) {
    // sessionId can live on the entry directly or be derived from the uuid
    const sid =
      entry.sessionId ?? (entry.uuid ? entry.uuid.split("-").slice(0, 3).join("-") : null);

    if (!sid) continue;

    if (!bySession.has(sid)) {
      bySession.set(sid, []);
    }
    bySession.get(sid)!.push(entry);
  }

  // If nothing was grouped (no sessionId fields), treat the whole file as one
  // session using the filename as the id.
  if (bySession.size === 0 && entries.length > 0) {
    const fallbackId = path.basename(filePath, path.extname(filePath));
    bySession.set(fallbackId, entries);
  }

  const sessions: ParsedSession[] = [];

  // Extract context snapshot once for the whole file (session-start data)
  const contextSnapshot = extractContextSnapshot(filePath);

  for (const [session_id, sessionEntries] of bySession) {
    let turn_count = 0;
    let char_count = 0;
    const tool_calls: Record<string, number> = {};
    let had_rework = false;
    let earliest_timestamp = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let hasRealUsage = false;

    for (const entry of sessionEntries) {
      // Count message turns
      if (entry.message) {
        const role = entry.message.role;
        if (role === "user" || role === "assistant") {
          turn_count++;
        }

        const content = entry.message.content;
        const text = extractTextFromContent(content);
        char_count += text.length;

        // Rework detection on assistant messages
        if (role === "assistant" && text && detectRework(text)) {
          had_rework = true;
        }

        // Tool call counting from assistant messages
        if (role === "assistant") {
          const toolNames = extractToolName(content);
          for (const name of toolNames) {
            tool_calls[name] = (tool_calls[name] ?? 0) + 1;
          }
        }

        // Accumulate real API token usage
        const usage = entry.message.usage;
        if (usage) {
          inputTokens += usage.input_tokens ?? 0;
          outputTokens += usage.output_tokens ?? 0;
          cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
          cacheReadTokens += usage.cache_read_input_tokens ?? 0;
          hasRealUsage = true;
        }
      }

      // Track earliest timestamp for the session
      if (entry.timestamp && !earliest_timestamp) {
        earliest_timestamp = entry.timestamp;
      }
    }

    const actualTokens = hasRealUsage
      ? {
          input: inputTokens,
          output: outputTokens,
          cacheCreation: cacheCreationTokens,
          cacheRead: cacheReadTokens,
        }
      : undefined;

    sessions.push({
      session_id,
      project: projectName,
      timestamp: earliest_timestamp || new Date().toISOString(),
      turn_count,
      estimated_tokens: Math.ceil(char_count / 4.5),
      tool_calls,
      had_rework,
      actualTokens,
      contextSnapshot: contextSnapshot.mcpServers.length > 0 || contextSnapshot.systemPromptTokens > 0
        ? contextSnapshot
        : undefined,
    });
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

export interface DiscoveredProject {
  name: string;
  conversationFile: string;
}

/**
 * Scan ~/.claude/projects/ and return all projects that have a conversations
 * JSONL file. Claude Code stores conversations at different paths depending on
 * the version:
 *   ~/.claude/projects/<slug>/conversations.jsonl   (older)
 *   ~/.claude/projects/<slug>/<uuid>.jsonl           (newer, one file per session)
 */
/**
 * Derive the Claude Code project slug for a given absolute directory path.
 * Matches Claude Code's own encoding: leading slash removed, separators become dashes.
 * e.g. /Users/leo/Git/patina → -Users-leo-Git-patina
 */
export function cwdToSlug(cwd: string): string {
  return (
    "-" +
    cwd
      .split("/")
      .filter((p) => p)
      .join("-")
  );
}

export function discoverProjects(
  claudeDir?: string,
  includeSlugs?: string[],
  excludeSlugs?: string[],
): DiscoveredProject[] {
  const baseDir = claudeDir ?? path.join(os.homedir(), ".claude", "projects");

  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const projects: DiscoveredProject[] = [];
  const projectDirs = fs.readdirSync(baseDir, { withFileTypes: true });

  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;

    const projectName = dirent.name;

    if (includeSlugs && !includeSlugs.some((s) => projectName.includes(s))) continue;
    if (excludeSlugs?.length && excludeSlugs.some((s) => projectName.includes(s))) continue;

    const projectPath = path.join(baseDir, projectName);
    const files = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      projects.push({
        name: projectName,
        conversationFile: path.join(projectPath, file),
      });
    }
  }

  return projects;
}
