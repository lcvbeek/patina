import fs from "fs";

// ---------------------------------------------------------------------------
// Context snapshot — extract session-start overhead from JSONL files
//
// At session start, Claude Code loads system prompt components (rules, CLAUDE.md,
// skills, agents, MCP instructions) before the user types anything. This module
// extracts that overhead from JSONL attachment and usage entries, giving a
// picture of how much context was consumed before real work began.
// ---------------------------------------------------------------------------

export interface ContextSnapshot {
  /** Tokens written to cache at session start (system prompt cost). From first assistant message. */
  systemPromptTokens: number;
  /** MCP server names active in the session. From mcp_instructions_delta attachments. */
  mcpServers: string[];
  /** Deferred tool names loaded at session start. From deferred_tools_delta attachments. */
  deferredTools: string[];
  /** Model used in the session, e.g. "claude-sonnet-4-6". From first assistant message. */
  model?: string;
}

// ---------------------------------------------------------------------------
// Model context window lookup
// ---------------------------------------------------------------------------

/**
 * Known context window sizes by model ID prefix.
 * Longest prefix wins. Falls back to undefined if unknown.
 */
const MODEL_CONTEXT_WINDOWS: Array<{ prefix: string; tokens: number }> = [
  { prefix: "claude-opus-4-5", tokens: 200_000 },
  { prefix: "claude-opus-4-6", tokens: 1_000_000 },
  { prefix: "claude-sonnet-4-5", tokens: 200_000 },
  { prefix: "claude-sonnet-4-6", tokens: 1_000_000 },
  { prefix: "claude-haiku-4-5", tokens: 200_000 },
  { prefix: "claude-3-5-sonnet", tokens: 200_000 },
  { prefix: "claude-3-5-haiku", tokens: 200_000 },
  { prefix: "claude-3-opus", tokens: 200_000 },
  { prefix: "claude-3-haiku", tokens: 200_000 },
];

/**
 * Return the context window size in tokens for a given model ID, or undefined
 * if the model is not in the lookup table.
 */
export function modelContextWindow(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  const lower = modelId.toLowerCase();
  // Sort by prefix length descending so more specific prefixes match first
  const sorted = [...MODEL_CONTEXT_WINDOWS].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const { prefix, tokens } of sorted) {
    if (lower.startsWith(prefix)) return tokens;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// System prompt size labels
//
// Research (Chroma "Context Rot", 2025) shows LLM accuracy degrades with
// absolute token count, not percentage of window — the "attention budget" is
// finite. But percentage still matters at the high end: 100k tokens is fine
// on a 1M window but catastrophic on 200k.
//
// We take the WORSE of absolute and percentage thresholds. A 60k system prompt
// is "Heavy" regardless of window size; a 30k system prompt on a 200k window
// is also "Heavy" because it's already 15% of attention budget consumed before
// any work starts.
// ---------------------------------------------------------------------------

export type SystemPromptLabel = "Lean" | "Moderate" | "Full" | "Heavy" | "Very heavy";

const LABEL_ORDER: SystemPromptLabel[] = ["Lean", "Moderate", "Full", "Heavy", "Very heavy"];

function absoluteLabel(tokens: number): SystemPromptLabel {
  if (tokens < 5_000) return "Lean";
  if (tokens < 15_000) return "Moderate";
  if (tokens < 30_000) return "Full";
  if (tokens < 60_000) return "Heavy";
  return "Very heavy";
}

function percentageLabel(tokens: number, windowSize: number): SystemPromptLabel {
  const pct = tokens / windowSize;
  if (pct < 0.025) return "Lean";
  if (pct < 0.075) return "Moderate";
  if (pct < 0.15) return "Full";
  if (pct < 0.3) return "Heavy";
  return "Very heavy";
}

/**
 * Classify system prompt size, taking the worse of absolute and percentage
 * thresholds. Window size is optional — falls back to absolute-only if unknown.
 */
export function systemPromptSizeLabel(
  tokens: number,
  windowSize: number | undefined,
): SystemPromptLabel {
  const abs = absoluteLabel(tokens);
  if (windowSize == null) return abs;
  const pct = percentageLabel(tokens, windowSize);
  // Return whichever is worse (later in LABEL_ORDER)
  return LABEL_ORDER.indexOf(abs) >= LABEL_ORDER.indexOf(pct) ? abs : pct;
}

interface RawEntry {
  type?: string;
  attachment?: {
    type?: string;
    addedNames?: string[];
  };
  message?: {
    model?: string;
    usage?: {
      cache_creation_input_tokens?: number;
    };
  };
}

/**
 * Extract a ContextSnapshot from the first ~50 entries of a JSONL session file.
 * Reads only as far as needed — stops once both attachment types and first usage
 * are found. Returns a zeroed snapshot if the file is unreadable or has no data.
 */
export function extractContextSnapshot(filePath: string): ContextSnapshot {
  const snapshot: ContextSnapshot = {
    systemPromptTokens: 0,
    mcpServers: [],
    deferredTools: [],
    model: undefined,
  };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return snapshot;
  }

  let foundUsage = false;
  let lineCount = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    lineCount++;
    if (lineCount > 100) break; // Only scan the preamble of the file

    let entry: RawEntry;
    try {
      entry = JSON.parse(trimmed) as RawEntry;
    } catch {
      continue;
    }

    // Collect MCP server names from mcp_instructions_delta attachments
    if (
      entry.type === "attachment" &&
      entry.attachment?.type === "mcp_instructions_delta" &&
      Array.isArray(entry.attachment.addedNames)
    ) {
      for (const name of entry.attachment.addedNames) {
        if (typeof name === "string" && !snapshot.mcpServers.includes(name)) {
          snapshot.mcpServers.push(name);
        }
      }
    }

    // Collect deferred tool names from deferred_tools_delta attachments
    if (
      entry.type === "attachment" &&
      entry.attachment?.type === "deferred_tools_delta" &&
      Array.isArray(entry.attachment.addedNames)
    ) {
      for (const name of entry.attachment.addedNames) {
        if (typeof name === "string" && !snapshot.deferredTools.includes(name)) {
          snapshot.deferredTools.push(name);
        }
      }
    }

    // Capture system prompt cost and model from first assistant message with cache_creation tokens
    if (!foundUsage) {
      const cacheTokens = entry.message?.usage?.cache_creation_input_tokens;
      if (typeof cacheTokens === "number" && cacheTokens > 0) {
        snapshot.systemPromptTokens = cacheTokens;
        if (typeof entry.message?.model === "string") {
          snapshot.model = entry.message.model;
        }
        foundUsage = true;
      }
    }

    // Stop early if we have everything
    if (foundUsage && snapshot.mcpServers.length > 0 && snapshot.deferredTools.length > 0) {
      break;
    }
  }

  return snapshot;
}
