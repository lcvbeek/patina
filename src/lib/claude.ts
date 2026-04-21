/**
 * Shared Claude invocation layer.
 *
 * Priority order:
 *   1. Claude Code CLI (`claude` on PATH)  — uses existing auth, respects Max plan
 *   2. ANTHROPIC_API_KEY env var            — direct SDK call, billed separately
 *
 * Both paths accept a prompt string and return the raw text response.
 * JSON parsing is left to the caller.
 */

import { spawnSync, spawn } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-5";

let claudeCliAvailableCache: boolean | undefined;
function claudeCliAvailable(): boolean {
  if (claudeCliAvailableCache === undefined) {
    const result = spawnSync("claude", ["--version"], { encoding: "utf8" });
    claudeCliAvailableCache = !result.error && result.status === 0;
  }
  return claudeCliAvailableCache;
}

function callViaCli(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "text", "--model", "sonnet"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.stdin.write(prompt, "utf8");
    child.stdin.end();

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        reject(new Error(stderr || "Claude CLI exited with non-zero status"));
      } else {
        resolve(Buffer.concat(stdoutChunks).toString("utf8").trim());
      }
    });
  });
}

async function callViaApi(prompt: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const block = message.content[0];
  if (block.type !== "text") {
    throw new Error("Unexpected response type from Anthropic API");
  }

  return block.text.trim();
}

function extractJson(raw: string): string {
  // Fast path: already bare JSON
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  // Strip a single ```json ... ``` fence
  const fenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (fenced.startsWith("{") || fenced.startsWith("[")) return fenced;

  // Claude prefixed the JSON with prose — extract the first {...} block
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) return raw.slice(start, end + 1);

  return trimmed;
}

async function callClaude(prompt: string): Promise<string> {
  if (claudeCliAvailable()) {
    return callViaCli(prompt);
  } else if (process.env.ANTHROPIC_API_KEY) {
    return callViaApi(prompt);
  } else {
    throw new Error(
      "No Claude access found.\n" +
        "  Option 1: Install Claude Code — https://claude.ai/code\n" +
        "  Option 2: Set the ANTHROPIC_API_KEY environment variable",
    );
  }
}

/**
 * Shared analyst preamble used by all patina synthesis prompts.
 *
 * Establishes role, grounding rules, and output conventions that are identical
 * whether the caller is `patina capture --synth` (plain-text, 4 sentences) or
 * `patina run` (structured JSON retro cycle). Each caller appends its own
 * output-format spec and data sections on top of this.
 */
export const ANALYST_PREAMBLE =
  "You are a behavioral pattern analyst embedded in a human-AI pair programming workflow.\n" +
  "Your job is to surface patterns in how a developer works with AI — grounded strictly in the data provided.\n\n" +
  "Core rules (apply to every response):\n" +
  "- Ground every claim in data that is explicitly present; skip inferences you cannot back up\n" +
  "- Do not hedge with 'may', 'might', 'could suggest', 'hints that' — assert or omit\n" +
  "- Do not paraphrase or repeat the user's own text back to them\n" +
  "- When referencing a working agreement, name or quote it exactly as it appears in PATINA.md\n" +
  "- Be direct and specific — no generic coaching advice\n" +
  "- Optimize for machine inference: use short declarative sentences, minimal connective tissue, no prose padding\n";

/**
 * Shared PATINA.md instruction-editing rules injected into any synthesis prompt
 * that proposes a `proposed_instruction` change (both `patina run` and `patina capture --synth`).
 */
export function patinaMdEditingRules(maxLines: number, maxChars: number): string {
  return (
    "CONTEXT ENGINEERING RULES FOR proposed_instruction:\n" +
    `The core PATINA.md must stay under ${maxLines} lines / ${maxChars} chars (optimize for token count, not readability). ` +
    'Proposed instructions must be imperative ("Do X" / "Never Y"), not descriptive. ' +
    "Each must apply to >50% of sessions and be measurable. " +
    "Prefer replacing a stale instruction over adding a new one. " +
    "If the core would exceed the cap, propose which existing entry to remove.\n" +
    "Sections 1-3 are the always-loaded core. Sections 4-7 live in spoke files (.patina/context/) and are loaded on demand.\n" +
    'The "action" field should be "add" (new entry), "replace" (update existing), or "remove" (prune stale entry).\n' +
    'If action is "replace", include the text being replaced in the "replaces" field.\n\n' +
    "DUPLICATE CHECK (mandatory): Before proposing any addition, read every line of the Current Living Doc. " +
    "If the proposed text — or any semantically equivalent instruction — already appears anywhere in that document, you MUST NOT propose adding it. " +
    "Instead, either propose a replacement that improves the existing entry, or propose removing a different stale entry.\n\n" +
    "PRUNING CHECK: Review each existing bullet in the core PATINA.md. " +
    "If an instruction was not relevant to any session this cycle, contradicts user preferences, " +
    "or duplicates another entry, propose removing it.\n\n" +
    "STYLE RULES (match the init template exactly):\n" +
    "- Working Agreements bullets: 'Topic: Imperative sentence.' format (e.g. 'Scope: Stay within the stated task.')\n" +
    "- Behavior Contract bullets: single imperative clause, no sub-clauses\n" +
    "- Hard Guardrails: table row only — never expand a guardrail into prose\n" +
    "- One clause per bullet. Never explain or justify — rationale lives in the cycle report, not PATINA.md\n" +
    "- No hedging: never write 'try to', 'consider', 'where possible', 'ideally', or 'generally'\n" +
    "- Compress aggressively: remove articles (a/the), use short labels, cut every unnecessary word to stay under cap\n" +
    "- DISTIL, never transcribe: rewrite raw intent into compressed form — do not copy what the user said\n" +
    "- Working Agreements format — WRONG: 'Stop and ask before: Starting any high-effort or high-cost task where requirements are still ambiguous; spawning any agent using a frontier model (e.g. Opus); taking any action that touches shared infrastructure.'\n" +
    "- Working Agreements format — RIGHT: 'Pause: Confirm before ambiguous high-cost tasks, frontier model spawns, shared infra changes.'\n" +
    "- Working Agreements format — WRONG: 'Tone: Lead with code. Show a concise summary of changed files, what was decided and why, and what was intentionally left out. End with optional follow-up questions.'\n" +
    "- Working Agreements format — RIGHT: 'Tone: Lead with code. Flag affected callsites. Follow-up questions optional.'\n" +
    "- Behavior Contract format — WRONG: 'Always confirm with the user before proceeding with any action that modifies files or runs commands that could have side effects.'\n" +
    "- Behavior Contract format — RIGHT: 'Confirm plan before code; state scope in one sentence'\n" +
    "The diff field must be machine-inference-optimised: short label, colon, imperative clause. No prose. No explanation.\n\n" +
    "MARKDOWN LINT RULES for the diff field:\n" +
    "- Lists must have a blank line before and after them\n" +
    '- Bold labels followed by a list need a blank line between (e.g. "**Always do:**\\n\\n- item")\n' +
    "- No trailing spaces on lines\n" +
    "- Use consistent list markers (always -)\n"
  );
}

export async function callClaudeForText(prompt: string): Promise<string> {
  return callClaude(prompt);
}

export async function callClaudeForJson<T>(prompt: string): Promise<T> {
  const raw = await callClaude(prompt);
  const jsonStr = extractJson(raw);
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    throw new Error(
      `Could not parse Claude response as JSON.\n\nRaw response:\n${raw.slice(0, 500)}`,
    );
  }
}
