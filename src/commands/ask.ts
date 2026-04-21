import readline from "readline";
import {
  assertInitialised,
  getLatestCycleDate,
  readCaptures,
  readReflections,
  writeReflection,
  type Capture,
  type Reflection,
} from "../lib/storage.js";
import { loadQuestions } from "../lib/questions.js";
import { getGitAuthor } from "../lib/git.js";
import { generateId } from "./capture.js";
import { formatCapturesForDisplay } from "./reflect.js";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY;
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s);

// ---------------------------------------------------------------------------
// Question selection
// ---------------------------------------------------------------------------

interface Question {
  key: string;
  text: string;
}

/**
 * Collect the set of question keys the given author has already answered
 * in the current cycle (across any number of micro-reflections).
 */
function answeredKeys(reflections: Reflection[], author: string): Set<string> {
  const keys = new Set<string>();
  for (const r of reflections) {
    if (r.author !== author) continue;
    for (const [k, v] of Object.entries(r.answers)) {
      if (v && v.trim().length > 0) keys.add(k);
    }
  }
  return keys;
}

/**
 * Pick the first unanswered question for this author+cycle, preserving the
 * order defined in questions.ts. Returns null when all questions are answered.
 */
export function pickNextQuestion(
  questions: Question[],
  reflections: Reflection[],
  author: string,
): Question | null {
  const answered = answeredKeys(reflections, author);
  return questions.find((q) => !answered.has(q.key)) ?? null;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface AskOptions {
  show?: boolean;
  answer?: string;
  key?: string;
  json?: boolean;
}

interface Context {
  questions: Question[];
  reflections: Reflection[];
  captures: Capture[];
  author: string;
  lastCycleDate: string | null;
  remaining: number;
  total: number;
}

function loadContext(cwd: string): Context {
  const questions = loadQuestions(cwd);
  const lastCycleDate = getLatestCycleDate(cwd);
  const reflections = readReflections(cwd, lastCycleDate);
  const captures = readCaptures(cwd, lastCycleDate);
  const author = getGitAuthor();
  const answered = answeredKeys(reflections, author);
  return {
    questions,
    reflections,
    captures,
    author,
    lastCycleDate,
    remaining: questions.length - answered.size,
    total: questions.length,
  };
}

const CAPTURE_DISPLAY_LIMIT = 10;

function printRecentCaptures(captures: Capture[]): void {
  if (captures.length === 0) return;
  console.log(dim(`Recent captures (${captures.length}):`));
  for (const line of formatCapturesForDisplay(captures, CAPTURE_DISPLAY_LIMIT)) {
    console.log(`  ${line}`);
  }
  console.log();
}

function resolveQuestion(ctx: Context, keyOverride?: string): Question | null {
  if (keyOverride) {
    return ctx.questions.find((q) => q.key === keyOverride) ?? null;
  }
  return pickNextQuestion(ctx.questions, ctx.reflections, ctx.author);
}

function saveAnswer(cwd: string, ctx: Context, question: Question, text: string): Reflection {
  const reflection: Reflection = {
    id: generateId(new Date()),
    author: ctx.author,
    timestamp: new Date().toISOString(),
    cycleStart: ctx.lastCycleDate,
    answers: { [question.key]: text },
  };
  writeReflection(reflection, cwd);
  return reflection;
}

export async function askCommand(options: AskOptions): Promise<void> {
  assertInitialised();

  const cwd = process.cwd();
  const ctx = loadContext(cwd);
  const question = resolveQuestion(ctx, options.key);

  // ---- JSON mode: always machine-readable, no interaction ------------------
  if (options.json) {
    if (options.answer !== undefined) {
      if (!question) {
        console.log(JSON.stringify({ ok: false, error: "no_question", key: options.key ?? null }));
        process.exit(1);
      }
      const saved = saveAnswer(cwd, ctx, question, options.answer.trim());
      console.log(
        JSON.stringify({
          ok: true,
          saved: { id: saved.id, key: question.key },
          remaining: Math.max(0, ctx.remaining - 1),
          total: ctx.total,
        }),
      );
      return;
    }
    console.log(
      JSON.stringify({
        ok: true,
        question: question ? { key: question.key, text: question.text } : null,
        remaining: ctx.remaining,
        total: ctx.total,
        allDone: question === null,
        captures: ctx.captures.slice(-CAPTURE_DISPLAY_LIMIT).map((c) => ({
          id: c.id,
          text: c.text,
          tag: c.tag ?? null,
          timestamp: c.timestamp,
        })),
        captureCount: ctx.captures.length,
      }),
    );
    return;
  }

  // ---- No unanswered question ---------------------------------------------
  if (!question) {
    if (options.key) {
      console.error(`Unknown question key: ${options.key}`);
      console.error(`Valid keys: ${ctx.questions.map((q) => q.key).join(", ")}`);
      process.exit(1);
    }
    console.log(green("✓") + ` All ${ctx.total} reflection questions answered this cycle.`);
    return;
  }

  // ---- --show: print the next question and exit --------------------------
  if (options.show) {
    printRecentCaptures(ctx.captures);
    const progress = `[${ctx.total - ctx.remaining + 1}/${ctx.total}]`;
    console.log(`${dim(progress)} ${bold(question.text)}`);
    console.log(dim(`  key: ${question.key}`));
    return;
  }

  // ---- --answer: non-interactive record -----------------------------------
  if (options.answer !== undefined) {
    const text = options.answer.trim();
    if (!text) {
      console.error("Answer is empty.");
      process.exit(1);
    }
    const saved = saveAnswer(cwd, ctx, question, text);
    const left = Math.max(0, ctx.remaining - 1);
    console.log(`${green("✓")} Recorded answer to ${bold(question.key)} ${dim(`(${saved.id})`)}`);
    console.log(
      dim(
        left === 0
          ? "  All reflection questions answered this cycle."
          : `  ${left} of ${ctx.total} remaining.`,
      ),
    );
    return;
  }

  // ---- Interactive: print question, read stdin ----------------------------
  console.log();
  printRecentCaptures(ctx.captures);
  const progress = `[${ctx.total - ctx.remaining + 1}/${ctx.total}]`;
  console.log(`${dim(progress)} ${bold(question.text)}`);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question("> ", (a) => resolve(a.trim()));
  });
  rl.close();

  if (!answer) {
    console.log(dim("Skipped."));
    return;
  }

  saveAnswer(cwd, ctx, question, answer);
  const left = Math.max(0, ctx.remaining - 1);
  console.log();
  console.log(`${green("✓")} Recorded.`);
  console.log(
    dim(
      left === 0
        ? "  All reflection questions answered this cycle."
        : `  ${left} of ${ctx.total} remaining. Run \`patina ask\` again anytime.`,
    ),
  );
}
