import fs from "fs";
import path from "path";
import {
  assertInitialised,
  readAllSessions,
  getLatestCycleDate,
  readConfig,
  getSessionsInCycle,
  LIVING_DOC_FILE,
  CORE_MAX_LINES,
} from "../lib/storage.js";
import {
  computeAggregates,
  computeTrend,
  formatNumber,
  formatDate,
  trendArrow,
} from "../lib/metrics.js";
import { readGlobalMcpServers, readProjectMcpServers, activeServers, isStale } from "../lib/mcp.js";
import {
  modelContextWindow,
  systemPromptSizeLabel,
  type SystemPromptLabel,
} from "../lib/context-snapshot.js";
import {
  estimateTextTokens,
  exceedsPatinaCoreTokenTarget,
  PATINA_CORE_TOKEN_TARGET,
} from "../lib/token-estimate.js";

// ---------------------------------------------------------------------------
// ANSI colour helpers (no deps)
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY;

function bold(s: string): string {
  return isTTY ? `\x1b[1m${s}\x1b[0m` : s;
}
function dim(s: string): string {
  return isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}
function green(s: string): string {
  return isTTY ? `\x1b[32m${s}\x1b[0m` : s;
}
function yellow(s: string): string {
  return isTTY ? `\x1b[33m${s}\x1b[0m` : s;
}
function red(s: string): string {
  return isTTY ? `\x1b[31m${s}\x1b[0m` : s;
}
function cyan(s: string): string {
  return isTTY ? `\x1b[36m${s}\x1b[0m` : s;
}

function section(title: string): void {
  console.log(`\n${bold(title)}`);
  console.log(dim("─".repeat(title.length)));
}

function labelColour(label: SystemPromptLabel): (s: string) => string {
  switch (label) {
    case "Lean":
      return green;
    case "Moderate":
      return green;
    case "Full":
      return dim;
    case "Heavy":
      return yellow;
    case "Very heavy":
      return red;
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function statusCommand(): Promise<void> {
  assertInitialised();

  const sessions = readAllSessions();

  if (sessions.length === 0) {
    console.log("No sessions found. Run `patina ingest` to import Claude Code logs.");
    return;
  }

  const agg = computeAggregates(sessions);
  const trend = computeTrend(sessions);
  const livingDocPath = path.join(process.cwd(), LIVING_DOC_FILE);
  const coreEstimate = fs.existsSync(livingDocPath)
    ? estimateTextTokens(fs.readFileSync(livingDocPath, "utf-8"))
    : null;

  // Header
  console.log(bold("\npatina — status report"));
  if (agg.date_range) {
    console.log(
      dim(`${formatDate(agg.date_range.earliest)} → ${formatDate(agg.date_range.latest)}`),
    );
  }

  // ── Overview ──────────────────────────────────────────────────────────────
  section("Overview");

  console.log(`  Total sessions       ${bold(formatNumber(agg.total_sessions))}`);
  console.log(`  Total tokens (est.)  ${bold(formatNumber(agg.total_tokens))}`);
  console.log(`  Avg tokens/session   ${bold(formatNumber(agg.avg_tokens_per_session))}`);
  if (coreEstimate) {
    console.log(
      `  PATINA core (est.)   ${bold(`~${formatNumber(coreEstimate.estimatedTokens)} tokens`)} ${dim(`(${coreEstimate.lines} lines / ${formatNumber(coreEstimate.chars)} chars)`)}`,
    );
  }
  console.log(
    `  Sessions with rework ${bold(formatNumber(agg.rework_sessions))}  ${dim(`(${agg.rework_rate_pct}%)`)}`,
  );

  // ── Trend ─────────────────────────────────────────────────────────────────
  if (trend) {
    section("Trend  (first half → second half)");

    const tokenArrow = trendArrow(trend.token_delta_pct);
    const tokenColour =
      trend.token_delta_pct === null ? dim : trend.token_delta_pct > 10 ? yellow : green;
    console.log(`  Avg tokens/session   ${tokenColour(tokenArrow)}`);

    const reworkArrow = trendArrow(trend.rework_delta_pct);
    const reworkColour =
      trend.rework_delta_pct === null ? dim : trend.rework_delta_pct > 0 ? red : green;
    console.log(`  Rework rate          ${reworkColour(reworkArrow)}`);

    console.log(
      dim(
        `\n  Previous period: ${formatNumber(trend.previous.total_sessions)} sessions, ${formatNumber(trend.previous.avg_tokens_per_session)} avg tokens, ${trend.previous.rework_rate_pct}% rework`,
      ),
    );
    console.log(
      dim(
        `  Current period:  ${formatNumber(trend.current.total_sessions)} sessions, ${formatNumber(trend.current.avg_tokens_per_session)} avg tokens, ${trend.current.rework_rate_pct}% rework`,
      ),
    );
  } else if (sessions.length < 4) {
    section("Trend");
    console.log(dim("  Not enough data for trend analysis (need ≥ 4 sessions)."));
  }

  // ── Tool usage ────────────────────────────────────────────────────────────
  if (agg.tool_usage.length > 0) {
    section("Top tool usage");

    const topN = agg.tool_usage.slice(0, 10);
    const maxCount = topN[0].count;

    for (const { tool, count } of topN) {
      const barLen = Math.round((count / maxCount) * 20);
      const bar = cyan("█".repeat(barLen));
      const pct = Math.round((count / agg.total_sessions) * 100);
      console.log(
        `  ${tool.padEnd(28)} ${bar} ${dim(formatNumber(count))} calls  ${dim(`(${pct}% of sessions)`)}`,
      );
    }
  }

  // ── By project ────────────────────────────────────────────────────────────
  const projects = Object.entries(agg.sessions_by_project).sort(([, a], [, b]) => b - a);

  if (projects.length > 1) {
    section("Sessions by project");
    for (const [project, count] of projects) {
      const pct = Math.round((count / agg.total_sessions) * 100);
      console.log(`  ${project.padEnd(40)} ${bold(formatNumber(count))}  ${dim(`${pct}%`)}`);
    }
  }

  // ── Rework sessions ───────────────────────────────────────────────────────
  if (agg.rework_sessions > 0) {
    section("Sessions with rework detected");

    const reworkList = sessions
      .filter((s) => s.had_rework)
      .sort((a, b) => b.estimated_tokens - a.estimated_tokens)
      .slice(0, 5);

    for (const s of reworkList) {
      console.log(
        `  ${dim(formatDate(s.timestamp))}  ${s.project.slice(0, 32).padEnd(32)}  ~${formatNumber(s.estimated_tokens)} tokens  ${dim(s.session_id.slice(0, 12))}`,
      );
    }

    if (agg.rework_sessions > 5) {
      console.log(dim(`  … and ${agg.rework_sessions - 5} more`));
    }
  }

  // ── Context Load ──────────────────────────────────────────────────────────
  const cwd = process.cwd();
  const globalMcp = readGlobalMcpServers(cwd);
  const projectMcp = readProjectMcpServers(cwd);
  const activeGlobal = activeServers(globalMcp);
  const activeProject = activeServers(projectMcp);
  const totalActive = activeGlobal.length + activeProject.length;

  const availableFromPlugins = globalMcp.filter((s) => !s.enabled);

  // Derive system prompt token cost and model from ingested session snapshots
  const systemPromptCosts = sessions
    .map((s) => s.contextSnapshot?.systemPromptTokens ?? 0)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  const medianSystemPromptTokens =
    systemPromptCosts.length > 0
      ? systemPromptCosts[Math.floor(systemPromptCosts.length / 2)]
      : null;

  // Use the most commonly seen model across snapshots to determine window size
  const modelCounts = new Map<string, number>();
  for (const s of sessions) {
    const model = s.contextSnapshot?.model;
    if (model) modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
  }
  const typicalModel = [...modelCounts.entries()].sort(([, a], [, b]) => b - a)[0]?.[0];
  const windowSize = modelContextWindow(typicalModel);

  if (totalActive > 0 || availableFromPlugins.length > 0 || medianSystemPromptTokens !== null) {
    section("Context Load  (session-start overhead)");

    if (medianSystemPromptTokens !== null) {
      const label = systemPromptSizeLabel(medianSystemPromptTokens, windowSize);
      const colour = labelColour(label);
      const windowNote =
        windowSize != null
          ? `${Math.round((medianSystemPromptTokens / windowSize) * 100)}% of ${formatNumber(windowSize)} window`
          : "";
      console.log(
        `  System prompt (typical)  ${bold(formatNumber(medianSystemPromptTokens))} tokens  ${colour(`[${label}]`)}${windowNote ? `  ${dim(windowNote)}` : ""}`,
      );
    }

    const staleList = activeGlobal.filter(isStale);
    const scopeBreakdown =
      activeProject.length > 0
        ? `${activeGlobal.length} global, ${activeProject.length} project-scoped`
        : `${activeGlobal.length} global`;

    console.log(
      `  Active MCP servers       ${bold(String(totalActive))}  ${dim(`(${scopeBreakdown})`)}`,
    );

    if (totalActive > 5) {
      console.log(
        `  ${yellow("⚑")}  ${bold(String(totalActive))} active MCP servers — each loads tool definitions into context at session start`,
      );
    }

    if (staleList.length > 0) {
      const staleNames = staleList.map((s) => s.name).join(", ");
      console.log(
        `  ${yellow("⚑")}  ${bold(String(staleList.length))} stale plugin${staleList.length > 1 ? "s" : ""} (>90 days): ${dim(staleNames)}`,
      );
    }

    const globalNames = activeGlobal.map((s) => s.name).join(", ");
    if (globalNames) console.log(`  ${dim("global:")}    ${dim(globalNames)}`);

    const projectNames = activeProject.map((s) => s.name).join(", ");
    if (projectNames) console.log(`  ${dim("project:")}   ${projectNames}`);

    if (availableFromPlugins.length > 0) {
      const availableNames = availableFromPlugins.map((s) => s.name).join(", ");
      console.log(`  ${dim("available (not enabled):")}  ${dim(availableNames)}`);
    }

    if (medianSystemPromptTokens !== null) {
      console.log(
        `\n  ${dim("Tip: run")} ${bold("/context")} ${dim("in a fresh Claude Code session to see the live system prompt breakdown.")}`,
      );
    }
  }

  // Footer
  const lastCycle = getLatestCycleDate();
  if (lastCycle === null) {
    console.log(
      `\n${dim("No cycles yet. Run")} ${bold("patina run")} ${dim("to set up your AI operating agreements (takes ~10 min).")}`,
    );
  } else {
    console.log(
      `\n${dim("Last cycle:")} ${dim(lastCycle)}${dim(". Run")} ${bold("patina run")} ${dim("to start the next cycle.")}`,
    );
  }

  // Retro reminder nudge
  const config = readConfig();
  const threshold = config.retroReminderAfterSessions ?? 10;
  if (threshold > 0) {
    const { count } = getSessionsInCycle();
    if (count >= threshold) {
      console.log(`\n${yellow("⚑")}  ${bold(String(count))} sessions since your last retro.`);
      console.log(
        `   Run ${bold("patina reflect")} to record your reflections, then ${bold("patina run")}.`,
      );
    }
  }

  // PATINA.md size warning
  if (coreEstimate) {
    if (exceedsPatinaCoreTokenTarget(coreEstimate)) {
      console.log(
        `\n${yellow("⚑")}  ${bold("PATINA.md")} core estimate is ${bold(`~${formatNumber(coreEstimate.estimatedTokens)} tokens`)}, above target (~${PATINA_CORE_TOKEN_TARGET}).`,
      );
      console.log("   Keep the always-loaded core lean by moving detail to spoke files.");
    }

    if (coreEstimate.lines > CORE_MAX_LINES) {
      console.log(
        `\n${yellow("⚑")}  ${bold("PATINA.md")} is ${bold(String(coreEstimate.lines))} lines — over the ${CORE_MAX_LINES}-line limit.`,
      );
      console.log(`   Run ${bold("patina run")} to trim it.`);
    }
  }

  console.log();
}
