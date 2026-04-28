import fs from "fs";
import path from "path";
import readline from "readline";
import {
  assertInitialised,
  writeCapture,
  readCaptures,
  readAllSessions,
  writePendingDiff,
  readConfig,
  getDataDir,
  getSessionsInCycle,
  getLatestCycleDate,
  CAPTURE_TAGS,
  LIVING_DOC_FILE,
  CORE_MAX_LINES,
  CORE_MAX_CHARS,
  type Capture,
  type CaptureTag,
  type PendingDiff,
} from "../lib/storage.js";
import { getGitAuthor } from "../lib/git.js";
import { shouldSync, gitPush } from "../lib/data-dir-git.js";
import { applyCommand } from "./apply.js";
import { callClaudeForJson, ANALYST_PREAMBLE, patinaMdEditingRules } from "../lib/claude.js";
import { startSpinner } from "../lib/ui.js";
import { computeAggregates, formatNumber } from "../lib/metrics.js";
import { estimateTokensFromChars } from "../lib/token-estimate.js";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY;
function bold(s: string) {
  return isTTY ? `\x1b[1m${s}\x1b[0m` : s;
}
function dim(s: string) {
  return isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}
function green(s: string) {
  return isTTY ? `\x1b[32m${s}\x1b[0m` : s;
}
function cyan(s: string) {
  return isTTY ? `\x1b[36m${s}\x1b[0m` : s;
}
function yellow(s: string) {
  return isTTY ? `\x1b[33m${s}\x1b[0m` : s;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateId(now: Date): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

const TAG_SHORTHANDS: Record<string, CaptureTag> = {
  n: "near-miss",
  w: "went-well",
  f: "frustration",
  p: "pattern",
  o: "other",
};

export function resolveTag(input: string): CaptureTag | undefined {
  const lower = input.toLowerCase();
  return (
    TAG_SHORTHANDS[lower] ??
    (CAPTURE_TAGS.includes(lower as CaptureTag) ? (lower as CaptureTag) : undefined)
  );
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface CaptureOptions {
  tag?: string;
  synth?: boolean;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export function buildSynthesisPrompt(
  capture: Capture,
  recentCaptures: Capture[],
  livingDoc: string,
  metricsSummary: string,
): string {
  const tagLine = capture.tag ? ` [${capture.tag}]` : "";
  const priorLines =
    recentCaptures.length === 0
      ? "(no other captures this cycle)"
      : recentCaptures
          .map((c) => {
            const t = c.tag ? ` [${c.tag}]` : "";
            return `- ${c.timestamp.slice(0, 10)}${t}: ${c.text}`;
          })
          .join("\n");

  return (
    ANALYST_PREAMBLE +
    "\nOutput format (capture synthesis): respond with a JSON object — no markdown wrapper, raw JSON only.\n\n" +
    "The JSON must match this shape exactly:\n" +
    "{\n" +
    '  "insight": "4-sentence plain-text analysis, under 80 words. Sentence 1: the pattern this capture represents. Sentence 2: how it connects to (or contradicts) a named working agreement — quote or name it exactly. Sentence 3: what the session metrics suggest. Sentence 4: starts with \\"Try:\\" — a concrete, testable experiment with a specific trigger.",\n' +
    '  "proposed_instruction": {\n' +
    '    "section": "which PATINA.md section this belongs in",\n' +
    '    "rationale": "why this instruction change is warranted by this capture",\n' +
    '    "diff": "the imperative instruction text to add/replace/remove",\n' +
    '    "action": "add | replace | remove",\n' +
    '    "replaces": "if action is replace, the exact text being replaced — omit otherwise"\n' +
    "  }\n" +
    "}\n\n" +
    patinaMdEditingRules(CORE_MAX_LINES, CORE_MAX_CHARS) +
    "\n" +
    `## Just captured${tagLine}\n${capture.text}\n\n` +
    `## Other captures this cycle\n${priorLines}\n\n` +
    `## Session metrics (recent)\n${metricsSummary}\n\n` +
    `## Working agreements (PATINA.md)\n${livingDoc}`
  );
}

async function synthesiseCapture(capture: Capture, cwd: string): Promise<void> {
  const lastCycleDate = getLatestCycleDate(cwd);
  const allCaptures = readCaptures(cwd, lastCycleDate ?? undefined);
  // Exclude the just-saved capture itself, keep last 10
  const recentCaptures = allCaptures.filter((c) => c.id !== capture.id).slice(-10);

  const sessions = readAllSessions(cwd);
  const agg = computeAggregates(sessions);
  const metricsSummary = [
    `Sessions: ${agg.total_sessions}`,
    `Avg tokens/session: ${formatNumber(agg.avg_tokens_per_session)}`,
    `Rework rate: ${agg.rework_rate_pct}%`,
  ].join(", ");

  const livingDocPath = path.join(cwd, LIVING_DOC_FILE);
  const livingDoc = fs.existsSync(livingDocPath)
    ? fs.readFileSync(livingDocPath, "utf-8").slice(0, 2000)
    : "(no PATINA.md found)";

  const prompt = buildSynthesisPrompt(capture, recentCaptures, livingDoc, metricsSummary);

  if (process.env.PATINA_DEBUG)
    console.log("\n── synthesis prompt ──\n" + prompt + "\n─────────────────────\n");

  console.log();
  const stopSpinner = startSpinner("Synthesising...");

  interface CaptureInsight {
    insight: string;
    proposed_instruction: {
      section: string;
      rationale: string;
      diff: string;
      action?: "add" | "replace" | "remove";
      replaces?: string;
    };
  }

  let response: CaptureInsight;
  try {
    response = await callClaudeForJson<CaptureInsight>(prompt);
    const tokens = estimateTokensFromChars(prompt.length + JSON.stringify(response).length);
    stopSpinner(tokens);
  } catch (err) {
    stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${yellow("⚠")} Synthesis failed: ${msg}`);
    return;
  }

  console.log();
  for (const line of response.insight.split("\n")) {
    console.log(`  ${line}`);
  }

  const pi = response.proposed_instruction;
  const pendingDiff: PendingDiff = {
    section: pi.section,
    rationale: pi.rationale,
    diff: pi.diff,
    timestamp: new Date().toISOString(),
  };
  writePendingDiff(pendingDiff, cwd);

  await applyCommand({ yes: true });
}

export async function captureCommand(
  text: string | undefined,
  options: CaptureOptions,
): Promise<void> {
  assertInitialised();

  let captureText = text?.trim();
  let captureTag: CaptureTag | undefined;

  // Validate tag option if provided
  if (options.tag) {
    const resolved = resolveTag(options.tag);
    if (!resolved) {
      console.error(
        `Invalid tag "${options.tag}". Valid tags: ${CAPTURE_TAGS.join(", ")} (or shorthands: n, w, f, p, o)`,
      );
      process.exit(1);
    }
    captureTag = resolved;
  }

  // Interactive mode when no inline text given
  if (!captureText) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: isTTY,
    });

    captureText = await new Promise<string>((resolve) => {
      rl.question(`${bold("What happened?")}\n> `, (answer) => {
        resolve(answer.trim());
      });
    });

    if (!captureText) {
      rl.close();
      console.log(dim("Nothing captured."));
      return;
    }

    if (!captureTag) {
      const tagAnswer = await new Promise<string>((resolve) => {
        rl.question(
          `\n${bold("Tag")} ${dim(`(${CAPTURE_TAGS.join(" / ")} — or n/w/f/p/o — Enter to skip)`)}\n> `,
          (answer) => resolve(answer.trim().toLowerCase()),
        );
      });

      const resolved = resolveTag(tagAnswer);
      if (resolved) captureTag = resolved;
    }

    rl.close();
  }

  const now = new Date();
  const capture: Capture = {
    id: generateId(now),
    text: captureText,
    tag: captureTag,
    author: getGitAuthor(),
    timestamp: now.toISOString(),
  };

  const cwd = process.cwd();
  writeCapture(capture, cwd);

  const dataDirPath = getDataDir(cwd);
  if (shouldSync(readConfig(cwd), dataDirPath)) {
    gitPush(dataDirPath, `capture: ${now.toISOString().slice(0, 10)} ${capture.author}`);
  }

  const tagLabel = captureTag ? ` ${cyan(`[${captureTag}]`)}` : "";
  const when = now.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  console.log();
  console.log(`${green("✓")} Captured${tagLabel}: ${captureText}`);
  console.log(dim(`  by ${capture.author} · ${when}`));
  if (!options.synth) {
    console.log(dim("  Feeds into your next `patina run`."));
  }

  if (options.synth) {
    await synthesiseCapture(capture, cwd);
  }

  const config = readConfig();
  const threshold = config.retroReminderAfterSessions ?? 10;
  if (threshold > 0) {
    const { count } = getSessionsInCycle();
    if (count >= threshold) {
      console.log(
        dim(
          `\n  Tip: ${count} sessions since your last retro — consider running \`patina reflect\`.`,
        ),
      );
    }
  }

  console.log();
}
