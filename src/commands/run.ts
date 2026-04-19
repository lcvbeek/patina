import fs from "fs";
import path from "path";
import {
  assertInitialised,
  readAllSessions,
  readCaptures,
  readReflections,
  readConfig,
  getDataDir,
  LIVING_DOC_FILE,
  writePendingDiff,
  writeCycleFile,
  getLatestCycleDate,
  loadSpokeFiles,
  loadOpportunityBacklog,
  CORE_MAX_LINES,
  CORE_MAX_CHARS,
  type PendingDiff,
  type Capture,
  type Reflection,
} from "../lib/storage.js";
import { shouldSync, gitPull } from "../lib/data-dir-git.js";
import { runIngest } from "./ingest.js";
import { onboardCommand } from "./onboard.js";
import { callClaudeForJson, ANALYST_PREAMBLE, patinaMdEditingRules } from "../lib/claude.js";
import { startSpinner } from "../lib/ui.js";
import {
  computeAggregates,
  computeTrend,
  formatNumber,
  formatDate,
  trendArrow,
} from "../lib/metrics.js";
import type { SessionSummary } from "../lib/storage.js";

// ---------------------------------------------------------------------------
// ANSI helpers (no extra deps)
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
function cyan(s: string): string {
  return isTTY ? `\x1b[36m${s}\x1b[0m` : s;
}
function red(s: string): string {
  return isTTY ? `\x1b[31m${s}\x1b[0m` : s;
}

function hr(char = "─", len = 60): string {
  return dim(char.repeat(len));
}

function section(title: string): void {
  console.log(`\n${bold(title)}`);
  console.log(hr());
}

// ---------------------------------------------------------------------------
// Claude API synthesis response shape
// ---------------------------------------------------------------------------

interface PatternEntry {
  pattern: string;
  frequency: string;
  interpretation: string;
}

interface CoachingInsight {
  observation: string;
  what_it_suggests: string;
  one_thing_to_try: string;
}

interface ProposedInstruction {
  rationale: string;
  diff: string;
  section: string;
  action?: "add" | "replace" | "remove";
  replaces?: string;
}

interface Opportunity {
  observation: string;
  suggestion: string;
  effort: "low" | "medium" | "high";
}

export interface SynthesisResponse {
  cycle_summary: string;
  patterns: PatternEntry[];
  coaching_insight: CoachingInsight;
  proposed_instruction: ProposedInstruction;
  opportunity: Opportunity;
}

import { loadQuestions } from "../lib/questions.js";
import { readGlobalMcpServers, readProjectMcpServers, mcpSummaryText } from "../lib/mcp.js";
import { modelContextWindow, systemPromptSizeLabel } from "../lib/context-snapshot.js";

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

function loadLivingDoc(cwd: string): string {
  const file = path.join(cwd, LIVING_DOC_FILE);
  if (!fs.existsSync(file)) return "(no PATINA.md found)";
  const core = fs.readFileSync(file, "utf-8");

  // For synthesis, load the full picture: core + spoke files
  const spokes = loadSpokeFiles(cwd);
  const backlog = loadOpportunityBacklog(cwd);
  const extended = [spokes, backlog].filter(Boolean).join("\n\n");
  const combined = extended
    ? `${core}\n\n--- EXTENDED CONTEXT (spoke files, not always-loaded) ---\n\n${extended}`
    : core;

  // Truncate to 4000 chars to keep prompt tight (raised from 2000
  // since spoke files now carry sections 4-7 that were previously inline)
  if (combined.length > 4000) {
    return combined.slice(0, 4000) + "\n... [truncated]";
  }
  return combined;
}

function sessionsInCycle(
  sessions: SessionSummary[],
  lastCycleDate: string | null,
): SessionSummary[] {
  if (!lastCycleDate) return sessions;
  const cutoff = new Date(lastCycleDate + "T00:00:00Z").getTime();
  return sessions.filter((s) => new Date(s.timestamp).getTime() > cutoff);
}

// ---------------------------------------------------------------------------
// Compact session summary for Claude (avoid ballooning the prompt)
// ---------------------------------------------------------------------------

export function compressSessionsForPrompt(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return "(no sessions)";

  // Keep it to a compact table-style representation
  const lines: string[] = [
    `Total sessions: ${sessions.length}`,
    "Date | Author | Project | Tokens | Tools | Rework",
    "---  | ---    | ---     | ---    | ---   | ---",
  ];

  for (const s of sessions.slice(0, 30)) {
    const tools = Object.entries(s.tool_calls)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([t, c]) => `${t}:${c}`)
      .join(", ");
    const project = s.projectAlias ?? s.project.slice(0, 20);
    const author = s.author ?? "—";
    lines.push(
      `${s.timestamp.slice(0, 10)} | ${author} | ${project} | ${s.estimated_tokens} | ${tools || "none"} | ${s.had_rework ? "yes" : "no"}`,
    );
  }

  if (sessions.length > 30) {
    lines.push(`… and ${sessions.length - 30} more sessions (omitted for brevity)`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Build the user message for Claude
// ---------------------------------------------------------------------------

function formatReflectionsForPrompt(
  reflections: Reflection[],
  questions: Array<{ key: string; text: string }>,
): string {
  if (reflections.length === 0) return "(no reflections provided)";

  if (reflections.length === 1) {
    const r = reflections[0];
    return questions
      .map((q) => {
        const answer = r.answers[q.key] || "(no answer)";
        return `Q: ${q.text}\nA: ${answer}`;
      })
      .join("\n\n");
  }

  return reflections
    .map((r) => {
      const date = r.timestamp.slice(0, 10);
      const qa = questions
        .map((q) => {
          const answer = r.answers[q.key] || "(no answer)";
          return `Q: ${q.text}\nA: ${answer}`;
        })
        .join("\n\n");
      return `### ${r.author} (${date})\n\n${qa}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Build a ## Context Load section summarising session-start overhead across sessions.
 * Uses contextSnapshot data extracted from JSONL attachments and first-turn usage.
 * Returns null if no sessions have context snapshot data.
 */
function buildContextLoadSection(sessions: SessionSummary[]): string | null {
  const sessionsWithSnapshot = sessions.filter((s) => s.contextSnapshot != null);
  if (sessionsWithSnapshot.length === 0) return null;

  // Aggregate system prompt tokens (use median to avoid outliers from cache hits)
  const systemPromptCosts = sessionsWithSnapshot
    .map((s) => s.contextSnapshot!.systemPromptTokens)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);

  const typicalSystemPromptTokens =
    systemPromptCosts.length > 0
      ? systemPromptCosts[Math.floor(systemPromptCosts.length / 2)]
      : 0;

  // Derive window size from the most commonly seen model across snapshots
  const modelCounts = new Map<string, number>();
  for (const s of sessionsWithSnapshot) {
    const model = s.contextSnapshot!.model;
    if (model) modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
  }
  const typicalModel = [...modelCounts.entries()].sort(([, a], [, b]) => b - a)[0]?.[0];
  const windowSize = modelContextWindow(typicalModel);

  const labelText = typicalSystemPromptTokens > 0
    ? systemPromptSizeLabel(typicalSystemPromptTokens, windowSize)
    : null;

  // Collect unique MCP server names across all sessions
  const mcpCounts = new Map<string, number>();
  for (const s of sessionsWithSnapshot) {
    for (const name of s.contextSnapshot!.mcpServers) {
      mcpCounts.set(name, (mcpCounts.get(name) ?? 0) + 1);
    }
  }
  const mcpByFreq = [...mcpCounts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => (count > 1 ? `${name} (${count} sessions)` : name));

  const lines: string[] = [`Sessions with context data: ${sessionsWithSnapshot.length}`];

  if (typicalSystemPromptTokens > 0 && labelText) {
    const windowNote = windowSize != null
      ? ` (${Math.round((typicalSystemPromptTokens / windowSize) * 100)}% of ${formatNumber(windowSize)} window)`
      : "";
    lines.push(
      `Typical system prompt size: ~${formatNumber(typicalSystemPromptTokens)} tokens [${labelText}]${windowNote}`,
    );
  }

  if (mcpByFreq.length > 0) {
    lines.push(`MCP servers active: ${mcpByFreq.join(", ")}`);
  }

  return `## Context Load (session-start overhead)\n${lines.join("\n")}`;
}

export function buildSynthesisPrompt(params: {
  cycleStart: string;
  cycleEnd: string;
  sessionCount: number;
  sessions: SessionSummary[];
  captures: Capture[];
  reflections: Reflection[];
  livingDoc: string;
  lastCycleDate: string | null;
  cwd?: string;
}): string {
  const {
    cycleStart,
    cycleEnd,
    sessionCount,
    sessions,
    captures,
    reflections,
    livingDoc,
    lastCycleDate,
    cwd = process.cwd(),
  } = params;

  const agg = computeAggregates(sessions);
  const trend = computeTrend(sessions);

  const metricsSummary = [
    `Sessions: ${sessionCount}`,
    `Total tokens (est.): ${formatNumber(agg.total_tokens)}`,
    `Avg tokens/session: ${formatNumber(agg.avg_tokens_per_session)}`,
    `Rework rate: ${agg.rework_rate_pct}% (${agg.rework_sessions} sessions)`,
    `Top tools: ${agg.tool_usage
      .slice(0, 5)
      .map((t) => `${t.tool} (${t.count})`)
      .join(", ")}`,
  ].join("\n");

  const trendSummary = trend
    ? [
        `Token trend (first half → second half): ${trendArrow(trend.token_delta_pct)}`,
        `Rework trend: ${trendArrow(trend.rework_delta_pct)}`,
      ].join("\n")
    : "Not enough data for trend analysis.";

  const reflectionLines = formatReflectionsForPrompt(reflections, loadQuestions(cwd));

  const sessionTable = compressSessionsForPrompt(sessions);

  const capturesSection =
    captures.length > 0
      ? captures
          .map((c) => {
            const tag = c.tag ? ` [${c.tag}]` : "";
            return `- ${c.timestamp.slice(0, 10)} ${c.author}${tag}: ${c.text}`;
          })
          .join("\n")
      : null;

  const mcpSummary = mcpSummaryText(readGlobalMcpServers(), readProjectMcpServers(cwd));

  const contextLoadSection = buildContextLoadSection(sessions);

  return `## Cycle Overview
Date range: ${cycleStart} → ${cycleEnd}
${lastCycleDate ? `Previous cycle: ${lastCycleDate}` : "First cycle (no previous baseline)"}

## Metrics
${metricsSummary}

## Trend
${trendSummary}

## Session Detail
${sessionTable}

## Reflection Answers
${reflectionLines}
${capturesSection ? `\n## Notable Moments Captured This Cycle\n${capturesSection}` : ""}${contextLoadSection ? `\n${contextLoadSection}\n` : ""}${mcpSummary ? `\n${mcpSummary}\n` : ""}
## Current Living Doc (AI Operating Constitution)
\`\`\`
${livingDoc}
\`\`\`

---

Please analyse the above and respond with a JSON object matching this exact TypeScript type (no markdown wrapper, raw JSON only):

{
  "cycle_summary": "string — 2-3 sentences on what the data + reflection show",
  "patterns": [
    {
      "pattern": "what was observed",
      "frequency": "how often / how significant",
      "interpretation": "what it suggests about how the user works"
    }
  ],
  "coaching_insight": {
    "observation": "specific thing from their sessions",
    "what_it_suggests": "interpretation",
    "one_thing_to_try": "concrete, actionable nudge"
  },
  "proposed_instruction": {
    "rationale": "why this change is warranted",
    "diff": "the actual text to add/replace/remove in PATINA.md",
    "section": "which section it belongs in (e.g. '1. Working Agreements'). Sections 1-3 are always-loaded core; 4-7 are spoke files.",
    "action": "add | replace | remove",
    "replaces": "if action is replace, the exact text being replaced (optional)"
  },
  "opportunity": {
    "observation": "something currently slow/manual/inefficient",
    "suggestion": "how AI could help",
    "effort": "low | medium | high"
  }
}`;
}

// ---------------------------------------------------------------------------
// Call Claude API
// ---------------------------------------------------------------------------

async function callClaude(userMessage: string): Promise<SynthesisResponse> {
  const fullPrompt =
    ANALYST_PREAMBLE +
    "\nOutput format (retro cycle synthesis): respond with a JSON object — no markdown wrapper, raw JSON only.\n\n" +
    patinaMdEditingRules(CORE_MAX_LINES, CORE_MAX_CHARS) +
    "\n" +
    userMessage;

  return callClaudeForJson<SynthesisResponse>(fullPrompt);
}

// ---------------------------------------------------------------------------
// Display synthesis results
// ---------------------------------------------------------------------------

function displaySynthesis(synthesis: SynthesisResponse): void {
  section("Cycle Summary");
  console.log(`  ${synthesis.cycle_summary}`);

  section("Patterns Identified");
  if (synthesis.patterns.length === 0) {
    console.log(dim("  No patterns identified."));
  } else {
    for (let i = 0; i < synthesis.patterns.length; i++) {
      const p = synthesis.patterns[i];
      console.log(`\n  ${bold(`${i + 1}. ${p.pattern}`)}`);
      console.log(`     ${dim("Frequency:")} ${p.frequency}`);
      console.log(`     ${dim("Interpretation:")} ${p.interpretation}`);
    }
  }

  section("Coaching Insight");
  const ci = synthesis.coaching_insight;
  console.log(`  ${bold("Observation:")} ${ci.observation}`);
  console.log(`  ${bold("What it suggests:")} ${ci.what_it_suggests}`);
  console.log(`\n  ${green(bold("One thing to try:"))} ${ci.one_thing_to_try}`);

  section("Proposed Instruction Change");
  const pi = synthesis.proposed_instruction;
  console.log(`  ${bold("Section:")} ${cyan(pi.section)}`);
  console.log(`  ${bold("Rationale:")} ${pi.rationale}`);
  console.log(`\n  ${bold("Proposed addition:")}`);
  const diffLines = pi.diff.split("\n");
  for (const line of diffLines) {
    console.log(`  ${green("+ " + line)}`);
  }

  section("Opportunity");
  const opp = synthesis.opportunity;
  const effortColour = opp.effort === "low" ? green : opp.effort === "medium" ? yellow : cyan;
  console.log(`  ${bold("Observation:")} ${opp.observation}`);
  console.log(`  ${bold("Suggestion:")} ${opp.suggestion}`);
  console.log(`  ${bold("Effort:")} ${effortColour(opp.effort)}`);
}

// ---------------------------------------------------------------------------
// Build cycle markdown file
// ---------------------------------------------------------------------------

export function buildCycleMarkdown(params: {
  date: string;
  cycleStart: string;
  cycleEnd: string;
  reflections: Reflection[];
  synthesis: SynthesisResponse;
  sessions: SessionSummary[];
  cwd?: string;
}): string {
  const {
    date,
    cycleStart,
    cycleEnd,
    reflections,
    synthesis,
    sessions,
    cwd = process.cwd(),
  } = params;
  const questions = loadQuestions(cwd);

  const agg = computeAggregates(sessions);

  const reflectionSection =
    reflections.length === 0
      ? "_No reflections recorded for this cycle._"
      : reflections.length === 1
        ? questions
            .map((q) => {
              const answer = reflections[0].answers[q.key] || "_(no answer)_";
              return `**${q.text}**\n\n${answer}`;
            })
            .join("\n\n---\n\n")
        : reflections
            .map((r) => {
              const date = r.timestamp.slice(0, 10);
              const qa = questions
                .map((q) => {
                  const answer = r.answers[q.key] || "_(no answer)_";
                  return `**${q.text}**\n\n${answer}`;
                })
                .join("\n\n---\n\n");
              return `### ${r.author} (${date})\n\n${qa}`;
            })
            .join("\n\n");

  const patternsMd = synthesis.patterns
    .map(
      (p, i) =>
        `### Pattern ${i + 1}: ${p.pattern}\n- **Frequency:** ${p.frequency}\n- **Interpretation:** ${p.interpretation}`,
    )
    .join("\n\n");

  const topTools = agg.tool_usage
    .slice(0, 5)
    .map((t) => `- ${t.tool}: ${t.count} calls`)
    .join("\n");

  return `# Retro Cycle — ${date}

> Generated by \`patina run\` on ${new Date().toISOString()}
> Cycle period: ${cycleStart} → ${cycleEnd}
> Sessions analysed: ${sessions.length}

---

## Metrics Snapshot

| Metric | Value |
|---|---|
| Total sessions | ${agg.total_sessions} |
| Total tokens (est.) | ${formatNumber(agg.total_tokens)} |
| Avg tokens/session | ${formatNumber(agg.avg_tokens_per_session)} |
| Sessions with rework | ${agg.rework_sessions} (${agg.rework_rate_pct}%) |

### Top Tool Usage
${topTools || "_No tool usage recorded._"}

---

## Cycle Summary

${synthesis.cycle_summary}

---

## Patterns

${patternsMd || "_No patterns identified._"}

---

## Coaching Insight

**Observation:** ${synthesis.coaching_insight.observation}

**What it suggests:** ${synthesis.coaching_insight.what_it_suggests}

**One thing to try:** ${synthesis.coaching_insight.one_thing_to_try}

---

## Proposed Instruction Change

**Section:** ${synthesis.proposed_instruction.section}

**Rationale:** ${synthesis.proposed_instruction.rationale}

**Proposed addition:**

\`\`\`
${synthesis.proposed_instruction.diff}
\`\`\`

---

## Opportunity

**Observation:** ${synthesis.opportunity.observation}

**Suggestion:** ${synthesis.opportunity.suggestion}

**Effort:** ${synthesis.opportunity.effort}

---

## Reflection Answers

${reflectionSection}

`;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runCommand(options: { onboard?: boolean } = {}): Promise<void> {
  assertInitialised();

  const cwd = process.cwd();

  // ── 0. Sync dataDir before reading ────────────────────────────────────────

  const dataDir = getDataDir(cwd);
  if (shouldSync(readConfig(cwd), dataDir)) {
    gitPull(dataDir);
  }

  // ── 1. Load context ───────────────────────────────────────────────────────

  // Auto-ingest new sessions silently before running
  const { ingested: newSessions } = runIngest();
  if (newSessions > 0) {
    console.log(dim(`  Auto-ingested ${newSessions} new session(s) from Claude Code logs.`));
  }

  const lastCycleDate = getLatestCycleDate(cwd);

  // First cycle or explicit --onboard flag → framework-driven onboarding
  if (lastCycleDate === null || options.onboard) {
    await onboardCommand(cwd);
    return;
  }

  const allSessions = readAllSessions(cwd);

  if (allSessions.length === 0) {
    console.error(
      red("No sessions found.") + " Run `patina ingest` first to import Claude Code logs.",
    );
    process.exit(1);
  }
  const cycleSessions = sessionsInCycle(allSessions, lastCycleDate);
  const cycleCaptures = readCaptures(cwd, lastCycleDate);

  const today = new Date().toISOString().slice(0, 10);
  const cycleStart =
    lastCycleDate ?? allSessions.map((s) => s.timestamp.slice(0, 10)).sort()[0] ?? today;
  const cycleEnd = today;

  const livingDoc = loadLivingDoc(cwd);

  // ── Banner ─────────────────────────────────────────────────────────────────

  console.log(`\n${bold("patina run")} — AI-assisted retrospective`);
  console.log(hr());
  console.log(`  Cycle period : ${cyan(cycleStart)} → ${cyan(cycleEnd)}`);
  console.log(
    `  Sessions     : ${bold(String(cycleSessions.length))} ${dim(`(${allSessions.length} total ingested)`)}`,
  );
  if (lastCycleDate) {
    console.log(`  Last cycle   : ${dim(lastCycleDate)}`);
  } else {
    console.log(`  Last cycle   : ${dim("none (first cycle)")}`);
  }
  if (cycleCaptures.length > 0) {
    console.log(
      `  Captures     : ${bold(String(cycleCaptures.length))} ${dim("notable moment(s) queued")}`,
    );
  }

  // ── 2. Load reflections ───────────────────────────────────────────────────

  const cycleReflections = readReflections(cwd, lastCycleDate);

  if (cycleReflections.length === 0) {
    console.log(
      `  Reflections  : ${yellow("none")} ${dim("— run `patina reflect` to add your input")}`,
    );
  } else {
    const authors = [...new Set(cycleReflections.map((r) => r.author))].join(", ");
    console.log(`  Reflections  : ${bold(String(cycleReflections.length))} ${dim(`(${authors})`)}`);
  }
  console.log();
  console.log(hr());
  console.log();

  // ── 3. Claude API synthesis ───────────────────────────────────────────────

  const synthesisPrompt = buildSynthesisPrompt({
    cycleStart,
    cycleEnd,
    sessionCount: cycleSessions.length,
    sessions: cycleSessions.length > 0 ? cycleSessions : allSessions,
    captures: cycleCaptures,
    reflections: cycleReflections,
    livingDoc,
    lastCycleDate,
  });

  let synthesis: SynthesisResponse;
  const stopSpinner = startSpinner("Sending to Claude for synthesis...");

  try {
    synthesis = await callClaude(synthesisPrompt);
    stopSpinner();
  } catch (err) {
    stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${red("Claude CLI call failed:")} ${msg}`);
    console.log("Run `patina run` again to retry. Your reflections are already saved.");
    process.exit(1);
  }

  // ── 4. Display results ────────────────────────────────────────────────────

  console.log(`\n${bold("Synthesis complete.")}\n`);
  displaySynthesis(synthesis);

  // ── 5. Save outputs ───────────────────────────────────────────────────────

  // Save cycle file
  const sessionsForCycle = cycleSessions.length > 0 ? cycleSessions : allSessions;
  const cycleMarkdown = buildCycleMarkdown({
    date: today,
    cycleStart,
    cycleEnd,
    reflections: cycleReflections,
    synthesis,
    sessions: sessionsForCycle,
  });

  writeCycleFile(today, cycleMarkdown, cwd);

  // Save pending diff for patina diff/apply
  const pendingDiff: PendingDiff = {
    section: synthesis.proposed_instruction.section,
    rationale: synthesis.proposed_instruction.rationale,
    diff: synthesis.proposed_instruction.diff,
    timestamp: new Date().toISOString(),
    opportunity: synthesis.opportunity,
  };

  writePendingDiff(pendingDiff, cwd);

  // ── Footer ─────────────────────────────────────────────────────────────────

  console.log(`\n${hr()}`);
  console.log(`\n${bold("Saved:")}`);
  console.log(`  Cycle report   ${dim(`.patina/cycles/${today}.md`)}`);
  console.log();
  console.log(`Run ${cyan("`patina buff`")} to review and apply the proposed instruction change.`);
  console.log();
}
