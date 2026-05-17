import type {
  SessionSummary,
  Capture,
  Reflection,
  PendingDiff,
  CycleEntry,
} from "./storage.js";
import { computeAggregates, computeTrend, formatNumber, trendArrow } from "./metrics.js";
import { loadQuestions } from "./questions.js";
import { readGlobalMcpServers, readProjectMcpServers, mcpSummaryText } from "./mcp.js";
import { modelContextWindow, systemPromptSizeLabel } from "./context-snapshot.js";

// ---------------------------------------------------------------------------
// Synthesis response shape (what Claude returns)
// ---------------------------------------------------------------------------

export interface PatternEntry {
  pattern: string;
  frequency: string;
  interpretation: string;
}

export interface CoachingInsight {
  observation: string;
  what_it_suggests: string;
  one_thing_to_try: string;
}

export interface ProposedInstruction {
  rationale: string;
  diff: string;
  section: string;
  action?: "add" | "replace" | "remove";
  replaces?: string;
}

export interface Opportunity {
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

// ---------------------------------------------------------------------------
// Compact session summary for Claude (avoid ballooning the prompt)
// ---------------------------------------------------------------------------

export function compressSessionsForPrompt(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return "(no sessions)";

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
// Reflection / context-load formatting
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

function buildContextLoadSection(sessions: SessionSummary[]): string | null {
  const sessionsWithSnapshot = sessions.filter((s) => s.contextSnapshot != null);
  if (sessionsWithSnapshot.length === 0) return null;

  const systemPromptCosts = sessionsWithSnapshot
    .map((s) => s.contextSnapshot!.systemPromptTokens)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);

  const typicalSystemPromptTokens =
    systemPromptCosts.length > 0 ? systemPromptCosts[Math.floor(systemPromptCosts.length / 2)] : 0;

  const modelCounts = new Map<string, number>();
  for (const s of sessionsWithSnapshot) {
    const model = s.contextSnapshot!.model;
    if (model) modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
  }
  const typicalModel = [...modelCounts.entries()].sort(([, a], [, b]) => b - a)[0]?.[0];
  const windowSize = modelContextWindow(typicalModel);

  const labelText =
    typicalSystemPromptTokens > 0
      ? systemPromptSizeLabel(typicalSystemPromptTokens, windowSize)
      : null;

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
    const windowNote =
      windowSize != null
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

// ---------------------------------------------------------------------------
// Build the user message for Claude
// ---------------------------------------------------------------------------

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
  capabilitiesSection?: string | null;
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
    capabilitiesSection,
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
${capturesSection ? `\n## Notable Moments Captured This Cycle\n${capturesSection}` : ""}${contextLoadSection ? `\n${contextLoadSection}\n` : ""}${mcpSummary ? `\n${mcpSummary}\n` : ""}${capabilitiesSection ? `\n${capabilitiesSection}\n` : ""}
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
// Cycle synthesis orchestration (owning module for the Cycle domain concept)
// ---------------------------------------------------------------------------

export interface CycleSynthesisInput {
  today: string;
  cycleStart: string;
  cycleEnd: string;
  lastCycleDate: string | null;

  livingDoc: string;
  capabilitiesSection: string | null;

  sessions: SessionSummary[];
  captures: Capture[];
  reflections: Reflection[];

  priorCycles: CycleEntry[];
  patinaDocTokens: number;

  cwd?: string;

  callClaude: (prompt: string) => Promise<{
    synthesis: SynthesisResponse;
    tokens: number;
  }>;
}

export interface CycleSynthesisResult {
  synthesis: SynthesisResponse;
  synthesisTokens: number;
  cycleMarkdown: string;
  pendingDiff: PendingDiff;
  nextCycleEntry: CycleEntry;
}

export async function synthesizeCycle(
  input: CycleSynthesisInput,
): Promise<CycleSynthesisResult> {
  const {
    today,
    cycleStart,
    cycleEnd,
    lastCycleDate,
    livingDoc,
    capabilitiesSection,
    sessions,
    captures,
    reflections,
    patinaDocTokens,
    cwd = process.cwd(),
    callClaude,
  } = input;

  const synthesisPrompt = buildSynthesisPrompt({
    cycleStart,
    cycleEnd,
    sessionCount: sessions.length,
    sessions,
    captures,
    reflections,
    livingDoc,
    lastCycleDate,
    cwd,
    capabilitiesSection,
  });

  const { synthesis, tokens: synthesisTokens } = await callClaude(synthesisPrompt);

  const cycleMarkdown = buildCycleMarkdown({
    date: today,
    cycleStart,
    cycleEnd,
    reflections,
    synthesis,
    sessions,
    cwd,
  });

  const pendingDiff: PendingDiff = {
    section: synthesis.proposed_instruction.section,
    rationale: synthesis.proposed_instruction.rationale,
    diff: synthesis.proposed_instruction.diff,
    timestamp: new Date().toISOString(),
    opportunity: synthesis.opportunity,
  };

  const agg = computeAggregates(sessions);
  const nextCycleEntry: CycleEntry = {
    cycle_id: today,
    created_at: new Date().toISOString(),
    session_count: sessions.length,
    total_tokens: agg.total_tokens,
    rework_count: agg.rework_sessions,
    synthesis_tokens: synthesisTokens,
    patina_md_tokens: patinaDocTokens,
  };

  return { synthesis, synthesisTokens, cycleMarkdown, pendingDiff, nextCycleEntry };
}
