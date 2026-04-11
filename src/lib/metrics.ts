import type { SessionSummary } from "./storage.js";

// ---------------------------------------------------------------------------
// Aggregate metrics calculated from a set of session summaries
// ---------------------------------------------------------------------------

export interface AggregateMetrics {
  total_sessions: number;
  total_tokens: number;
  avg_tokens_per_session: number;
  rework_sessions: number;
  rework_rate_pct: number;
  tool_usage: Array<{ tool: string; count: number }>;
  sessions_by_project: Record<string, number>;
  date_range: { earliest: string; latest: string } | null;
}

export function computeAggregates(sessions: SessionSummary[]): AggregateMetrics {
  if (sessions.length === 0) {
    return {
      total_sessions: 0,
      total_tokens: 0,
      avg_tokens_per_session: 0,
      rework_sessions: 0,
      rework_rate_pct: 0,
      tool_usage: [],
      sessions_by_project: {},
      date_range: null,
    };
  }

  const total_tokens = sessions.reduce((sum, s) => sum + s.estimated_tokens, 0);
  const rework_sessions = sessions.filter((s) => s.had_rework).length;

  // Tool usage aggregation
  const toolCounts: Record<string, number> = {};
  for (const session of sessions) {
    for (const [tool, count] of Object.entries(session.tool_calls)) {
      toolCounts[tool] = (toolCounts[tool] ?? 0) + count;
    }
  }
  const tool_usage = Object.entries(toolCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([tool, count]) => ({ tool, count }));

  // Project breakdown
  const sessions_by_project: Record<string, number> = {};
  for (const session of sessions) {
    sessions_by_project[session.project] = (sessions_by_project[session.project] ?? 0) + 1;
  }

  // Date range
  const timestamps = sessions
    .map((s) => s.timestamp)
    .filter(Boolean)
    .sort();

  const date_range =
    timestamps.length > 0
      ? { earliest: timestamps[0], latest: timestamps[timestamps.length - 1] }
      : null;

  return {
    total_sessions: sessions.length,
    total_tokens,
    avg_tokens_per_session: Math.round(total_tokens / sessions.length),
    rework_sessions,
    rework_rate_pct: Math.round((rework_sessions / sessions.length) * 100),
    tool_usage,
    sessions_by_project,
    date_range,
  };
}

// ---------------------------------------------------------------------------
// Period splitting — split sessions into two halves for trend comparison
// ---------------------------------------------------------------------------

export interface TrendComparison {
  previous: AggregateMetrics;
  current: AggregateMetrics;
  token_delta_pct: number | null;
  rework_delta_pct: number | null;
}

export function computeTrend(sessions: SessionSummary[]): TrendComparison | null {
  if (sessions.length < 4) return null; // not enough data for meaningful trend

  // Sort by timestamp and split in half
  const sorted = [...sessions].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const mid = Math.floor(sorted.length / 2);
  const previous = computeAggregates(sorted.slice(0, mid));
  const current = computeAggregates(sorted.slice(mid));

  const token_delta_pct =
    previous.avg_tokens_per_session > 0
      ? Math.round(
          ((current.avg_tokens_per_session - previous.avg_tokens_per_session) /
            previous.avg_tokens_per_session) *
            100,
        )
      : null;

  const rework_delta_pct =
    previous.rework_rate_pct !== null ? current.rework_rate_pct - previous.rework_rate_pct : null;

  return { previous, current, token_delta_pct, rework_delta_pct };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function trendArrow(delta: number | null): string {
  if (delta === null) return "";
  if (delta > 0) return `▲ +${delta}%`;
  if (delta < 0) return `▼ ${delta}%`;
  return "→ 0%";
}
