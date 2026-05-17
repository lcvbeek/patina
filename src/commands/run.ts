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
  readMetrics,
  mergeAndWriteMetrics,
  readPatinaDocTokens,
  CORE_MAX_LINES,
  CORE_MAX_CHARS,
} from "../lib/storage.js";
import { shouldSync, gitPull } from "../lib/data-dir-git.js";
import { runIngest } from "./ingest.js";
import { onboardCommand } from "./onboard.js";
import { applyCommand } from "./apply.js";
import { fetchClaudeCapabilities } from "../lib/capabilities.js";
import { callClaudeForJson, ANALYST_PREAMBLE, patinaMdEditingRules } from "../lib/claude.js";
import { startSpinner } from "../lib/ui.js";
import { formatNumber } from "../lib/metrics.js";
import type { SessionSummary } from "../lib/storage.js";
import {
  estimateTextTokens,
  type TextTokenEstimate,
} from "../lib/token-estimate.js";
import {
  synthesizeCycle,
  type SynthesisResponse,
} from "../lib/cycle.js";

// Re-export for backwards compatibility with existing test imports.
export {
  compressSessionsForPrompt,
  buildSynthesisPrompt,
  buildCycleMarkdown,
  type SynthesisResponse,
} from "../lib/cycle.js";

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
// Context loading (filesystem I/O)
// ---------------------------------------------------------------------------

function loadLivingDoc(cwd: string): string {
  const file = path.join(cwd, LIVING_DOC_FILE);
  if (!fs.existsSync(file)) return "(no PATINA.md found)";
  const core = fs.readFileSync(file, "utf-8");

  const spokes = loadSpokeFiles(cwd);
  const backlog = loadOpportunityBacklog(cwd);
  const extended = [spokes, backlog].filter(Boolean).join("\n\n");
  const combined = extended
    ? `${core}\n\n--- EXTENDED CONTEXT (spoke files, not always-loaded) ---\n\n${extended}`
    : core;

  if (combined.length > 4000) {
    return combined.slice(0, 4000) + "\n... [truncated]";
  }
  return combined;
}

function readPatinaCoreEstimate(cwd: string): TextTokenEstimate | null {
  const file = path.join(cwd, LIVING_DOC_FILE);
  if (!fs.existsSync(file)) return null;
  return estimateTextTokens(fs.readFileSync(file, "utf-8"));
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
// Claude adapter — wraps callClaudeForJson with the synthesis preamble/rules
// ---------------------------------------------------------------------------

async function callClaude(
  userMessage: string,
): Promise<{ synthesis: SynthesisResponse; tokens: number }> {
  const fullPrompt =
    ANALYST_PREAMBLE +
    "\nOutput format (retro cycle synthesis): respond with a JSON object — no markdown wrapper, raw JSON only.\n\n" +
    patinaMdEditingRules(CORE_MAX_LINES, CORE_MAX_CHARS) +
    "\n" +
    userMessage;

  if (process.env.PATINA_DEBUG)
    console.log("\n── synthesis prompt ──\n" + fullPrompt + "\n─────────────────────\n");

  const { result, tokens } = await callClaudeForJson<SynthesisResponse>(fullPrompt);
  return { synthesis: result, tokens };
}

// ---------------------------------------------------------------------------
// Display synthesis results
// ---------------------------------------------------------------------------

function displaySynthesis(synthesis: SynthesisResponse): void {
  section("Cycle Summary");
  console.log(`  ${synthesis.cycle_summary}`);

  section("Patterns");
  if (synthesis.patterns.length === 0) {
    console.log(dim("  none"));
  } else {
    for (const p of synthesis.patterns) {
      console.log(`\n  ${bold(p.pattern)} ${dim(`· ${p.frequency}`)}`);
      console.log(`  ${p.interpretation}`);
    }
  }

  section("Coaching");
  const ci = synthesis.coaching_insight;
  console.log(`  ${ci.observation}`);
  console.log(`  ${dim("→")} ${ci.what_it_suggests}`);
  console.log(`\n  ${green("try:")} ${ci.one_thing_to_try}`);

  section("Proposed Change");
  const pi = synthesis.proposed_instruction;
  console.log(`  ${dim(pi.section)}  ${dim(`[${pi.action ?? "add"}]`)}`);
  console.log(`  ${dim(pi.rationale)}`);
  const diffLines = pi.diff.split("\n");
  for (const line of diffLines) {
    console.log(`  ${green("+ " + line)}`);
  }

  section("Opportunity");
  const opp = synthesis.opportunity;
  const effortColour = opp.effort === "low" ? green : opp.effort === "medium" ? yellow : cyan;
  console.log(`  ${opp.observation}`);
  console.log(`  ${dim("→")} ${opp.suggestion}  ${effortColour(opp.effort)}`);
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

  const { ingested: newSessions } = runIngest();
  if (newSessions > 0) {
    console.log(dim(`  Auto-ingested ${newSessions} new session(s) from Claude Code logs.`));
  }

  const lastCycleDate = getLatestCycleDate(cwd);

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
  const coreEstimate = readPatinaCoreEstimate(cwd);

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
  if (coreEstimate) {
    console.log(
      `  PATINA core  : ${bold(`~${formatNumber(coreEstimate.estimatedTokens)} tokens`)} ${dim(`(${coreEstimate.lines} lines / ${formatNumber(coreEstimate.chars)} chars)`)}`,
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

  // ── 2.5. Fetch Claude capabilities (cached, silent on failure) ───────────
  const capabilitiesSection = await fetchClaudeCapabilities(cwd);

  // ── 3. Cycle synthesis ────────────────────────────────────────────────────

  const sessionsForCycle = cycleSessions.length > 0 ? cycleSessions : allSessions;
  const patinaDocTokens = readPatinaDocTokens(cwd);
  const priorMetrics = readMetrics(cwd);

  const stopSpinner = startSpinner("Sending to Claude for synthesis...");

  let result;
  try {
    result = await synthesizeCycle({
      today,
      cycleStart,
      cycleEnd,
      lastCycleDate,
      livingDoc,
      capabilitiesSection,
      sessions: sessionsForCycle,
      captures: cycleCaptures,
      reflections: cycleReflections,
      priorCycles: priorMetrics.cycles,
      patinaDocTokens,
      cwd,
      callClaude,
    });
    stopSpinner(result.synthesisTokens);
  } catch (err) {
    stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${red("Claude CLI call failed:")} ${msg}`);
    console.log("Run `patina run` again to retry. Your reflections are already saved.");
    process.exit(1);
  }

  // ── 4. Display results ────────────────────────────────────────────────────

  console.log(`\n${bold("Synthesis complete.")}\n`);
  displaySynthesis(result.synthesis);

  // ── 5. Save outputs ───────────────────────────────────────────────────────

  writeCycleFile(today, result.cycleMarkdown, cwd);
  writePendingDiff(result.pendingDiff, cwd);
  mergeAndWriteMetrics(cwd, result.nextCycleEntry);

  // ── 6. Auto-apply proposed instruction change ─────────────────────────────

  console.log(`\n${hr()}`);
  console.log(`\n${bold("Saved:")}`);
  console.log(`  Cycle report   ${dim(`.patina/cycles/${today}.md`)}`);
  console.log();

  await applyCommand({ yes: true });

  console.log(dim(`Review changes with: git diff`));
  console.log();
}
