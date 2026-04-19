import readline from "readline";
import {
  assertInitialised,
  getLatestCycleDate,
  getDataDir,
  readAllSessions,
  readConfig,
  writeReflection,
  type Reflection,
} from "../lib/storage.js";
import { generateId } from "./capture.js";
import { loadQuestions } from "../lib/questions.js";
import { getGitAuthor } from "../lib/git.js";
import { formatNumber } from "../lib/metrics.js";
import { shouldSync, gitPush } from "../lib/data-dir-git.js";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY;

function bold(s: string): string {
  return isTTY ? `\x1b[1m${s}\x1b[0m` : s;
}
function dim(s: string): string {
  return isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}
function cyan(s: string): string {
  return isTTY ? `\x1b[36m${s}\x1b[0m` : s;
}
function green(s: string): string {
  return isTTY ? `\x1b[32m${s}\x1b[0m` : s;
}

function hr(len = 60): string {
  return dim("─".repeat(len));
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
  });
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function reflectCommand(): Promise<void> {
  assertInitialised();

  const cwd = process.cwd();
  const lastCycleDate = getLatestCycleDate(cwd);

  // Show brief context so answers are grounded
  const allSessions = readAllSessions(cwd);
  const cycleSessions = lastCycleDate
    ? allSessions.filter(
        (s) => new Date(s.timestamp).getTime() > new Date(lastCycleDate + "T00:00:00Z").getTime(),
      )
    : allSessions;

  const totalTokens = cycleSessions.reduce((sum, s) => sum + s.estimated_tokens, 0);

  console.log(`\n${bold("patina reflect")} — record your reflections for the next retro`);
  console.log(hr());
  if (lastCycleDate) {
    console.log(`  Since last cycle : ${cyan(lastCycleDate)}`);
  }
  console.log(`  Sessions         : ${bold(String(cycleSessions.length))}`);
  console.log(`  Tokens (est.)    : ${bold(formatNumber(totalTokens))}`);
  console.log();
  console.log(
    dim("Answer each question. Press Enter to skip. Your responses feed into the next patina run."),
  );
  console.log();

  const questions = loadQuestions(cwd);
  const rl = createRL();
  const answers: Record<string, string> = {};

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const label = `${dim(`[${i + 1}/${questions.length}]`)} ${bold(q.text)}\n> `;
    const answer = await prompt(rl, label);
    if (answer) {
      answers[q.key] = answer;
    }
    console.log();
  }

  rl.close();

  const id = generateId(new Date());

  const reflection: Reflection = {
    id,
    author: getGitAuthor(),
    timestamp: new Date().toISOString(),
    cycleStart: lastCycleDate,
    answers,
  };

  writeReflection(reflection, cwd);

  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dataDir = getDataDir(cwd);

  if (shouldSync(readConfig(cwd), dataDir)) {
    gitPush(dataDir, `reflect: ${new Date().toISOString().slice(0, 10)} ${reflection.author}`);
  }

  console.log(hr());
  console.log();
  console.log(green("✓") + ` Reflection saved to ${dim(`${dataDir}/reflections/${safeId}.json`)}`);
  console.log();
  console.log(`Run ${cyan("`patina run`")} when ready to synthesise.`);
  console.log();
}
