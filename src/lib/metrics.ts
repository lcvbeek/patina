import type { SessionSummary, Metrics } from "./storage.js";

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

// ---------------------------------------------------------------------------
// Cycle ROI estimation
// ---------------------------------------------------------------------------

export interface CycleRoiEntry {
  date: string;
  overhead_tokens: number;
  rework_rate_pct: number;
  rework_delta_pp: number | null;
  est_sessions_avoided: number | null;
  est_tokens_saved: number | null;
  net_tokens: number | null;
}

export interface CycleRoiEstimate {
  latest: CycleRoiEntry | null;
  history: CycleRoiEntry[];
  has_enough_data: boolean;
}

export function computeCycleRoi(
  metrics: Metrics,
  avgTokensPerSession: number,
): CycleRoiEstimate {
  const sorted = [...metrics.cycles].sort((a, b) => a.cycle_id.localeCompare(b.cycle_id));

  if (sorted.length === 0) {
    return { latest: null, history: [], has_enough_data: false };
  }

  const history: CycleRoiEntry[] = sorted.map((cycle, idx) => {
    const synthesisTokens = cycle.synthesis_tokens ?? 0;
    const patinaMdTokens = cycle.patina_md_tokens ?? 0;
    const overhead_tokens = synthesisTokens + patinaMdTokens * cycle.session_count;

    const rework_rate_pct =
      cycle.session_count > 0
        ? Math.round((cycle.rework_count / cycle.session_count) * 100)
        : 0;

    const prev = idx > 0 ? sorted[idx - 1] : null;
    const prev_rework_rate_pct =
      prev != null && prev.session_count > 0
        ? Math.round((prev.rework_count / prev.session_count) * 100)
        : null;

    const rework_delta_pp =
      prev_rework_rate_pct !== null ? rework_rate_pct - prev_rework_rate_pct : null;

    let est_sessions_avoided: number | null = null;
    let est_tokens_saved: number | null = null;
    let net_tokens: number | null = null;

    if (rework_delta_pp !== null && rework_delta_pp < 0 && avgTokensPerSession > 0) {
      est_sessions_avoided =
        Math.round(((-rework_delta_pp / 100) * cycle.session_count) * 10) / 10;
      est_tokens_saved = Math.round(est_sessions_avoided * avgTokensPerSession * 2);
      net_tokens = est_tokens_saved - overhead_tokens;
    }

    return {
      date: cycle.cycle_id,
      overhead_tokens,
      rework_rate_pct,
      rework_delta_pp,
      est_sessions_avoided,
      est_tokens_saved,
      net_tokens,
    };
  });

  return {
    latest: history[history.length - 1] ?? null,
    history,
    has_enough_data: sorted.length >= 2,
  };
}
