import type { SessionSummary, CaptureTag } from "./storage.js";

export interface CaptureSuggestion {
  tag: CaptureTag;
  reason: string;
}

const HIGH_TOKEN_THRESHOLD = 8000;
const HEAVY_SYSTEM_PROMPT_THRESHOLD = 6000;
const MANY_MCP_SERVERS_THRESHOLD = 6;

/**
 * Suggest a single best-fit capture based on session-level signals.
 *
 * Important: this is meant to *nudge* the user to capture their own context,
 * not to auto-generate captures from session logs.
 */
export function suggestCaptureFromSessions(sessions: SessionSummary[]): CaptureSuggestion | null {
  if (sessions.length === 0) return null;

  const reworkCount = sessions.filter((s) => s.had_rework).length;
  if (reworkCount > 0) {
    const tag: CaptureTag = reworkCount >= 2 ? "pattern" : "frustration";
    const reason =
      reworkCount >= 2
        ? `Rework detected in ${reworkCount} newly ingested sessions.`
        : "Rework detected in a newly ingested session.";
    return { tag, reason };
  }

  const heavyContextCount = sessions.filter((s) => {
    const snap = s.contextSnapshot;
    if (!snap) return false;
    return (
      snap.systemPromptTokens >= HEAVY_SYSTEM_PROMPT_THRESHOLD ||
      snap.mcpServers.length >= MANY_MCP_SERVERS_THRESHOLD
    );
  }).length;
  if (heavyContextCount > 0) {
    const reason =
      heavyContextCount > 1
        ? `Heavy session-start context detected in ${heavyContextCount} sessions.`
        : "Heavy session-start context detected in a session.";
    return { tag: "pattern", reason };
  }

  const highTokenCount = sessions.filter((s) => s.estimated_tokens >= HIGH_TOKEN_THRESHOLD).length;
  if (highTokenCount > 0) {
    const reason =
      highTokenCount > 1
        ? `Large sessions detected (${highTokenCount} sessions were ~${HIGH_TOKEN_THRESHOLD}+ tokens).`
        : `A large session was detected (~${HIGH_TOKEN_THRESHOLD}+ tokens).`;
    return { tag: "pattern", reason };
  }

  return null;
}
