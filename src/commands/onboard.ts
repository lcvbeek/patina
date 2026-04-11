import fs from "fs";
import path from "path";
import readline from "readline";
import { LIVING_DOC_FILE, SPOKE_FILES, writeCycleFile, ensureSpokeFiles } from "../lib/storage.js";
import { callClaudeForJson } from "../lib/claude.js";

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
function red(s: string) {
  return isTTY ? `\x1b[31m${s}\x1b[0m` : s;
}
function hr(len = 60) {
  return dim("─".repeat(len));
}
function section(title: string) {
  console.log(`\n${bold(title)}`);
  console.log(hr());
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const QUESTIONS = [
  // Behavior Contract
  {
    key: "agent_purpose",
    label: "Behavior Contract",
    text: "What does your AI agent primarily help you with? (one sentence)",
  },
  {
    key: "always_do",
    label: null,
    text: "What should it ALWAYS do in every session?",
  },
  {
    key: "never_do",
    label: null,
    text: "What should it NEVER do, regardless of what you ask?",
  },
  {
    key: "tone",
    label: null,
    text: "How should it communicate? (e.g., direct and brief, explain its reasoning, lead with code)",
  },
  {
    key: "confidence_threshold",
    label: null,
    text: "When should it stop and ask rather than proceed?",
  },
  // Autonomy Map
  {
    key: "auto_ok",
    label: "Autonomy Map",
    text: "What's a task you'd trust it to handle fully automatically?",
  },
  {
    key: "always_review",
    label: null,
    text: "What's a scenario that should ALWAYS require your explicit approval, no matter what?",
  },
  // Eval Framework
  {
    key: "good_output",
    label: "Eval Framework",
    text: "What does good output look like for your most common task?",
  },
  {
    key: "biggest_fear",
    label: null,
    text: "What's your biggest fear — the thing you're most worried the agent might do wrong?",
  },
] as const;

// ---------------------------------------------------------------------------
// Synthesis response
// ---------------------------------------------------------------------------

export interface OnboardingResponse {
  summary: string;
  behavior_contract_md: string; // full markdown block for the agent contract
  autonomy_map_rows_md: string; // table rows to insert into the autonomy map (no header)
  eval_rows_md: string; // table rows to insert into the eval framework (no header)
}

// ---------------------------------------------------------------------------
// Claude call
// ---------------------------------------------------------------------------

async function callClaude(prompt: string): Promise<OnboardingResponse> {
  return callClaudeForJson<OnboardingResponse>(prompt);
}

// ---------------------------------------------------------------------------
// Build synthesis prompt
// ---------------------------------------------------------------------------

export function buildPrompt(answers: Record<string, string>): string {
  const qa = QUESTIONS.map((q) => `Q: ${q.text}\nA: ${answers[q.key] || "(no answer)"}`).join(
    "\n\n",
  );

  return `You are helping a developer set up their team's AI operating agreements for the first time.
Based on their answers below, produce a JSON object that populates three sections of their PATINA.md file.

${qa}

Respond with a JSON object matching this exact TypeScript type (raw JSON only, no markdown wrapper):

{
  "summary": "2-3 sentences describing what was established",
  "behavior_contract_md": "Full markdown block for one agent behavior contract. Use this structure exactly:\\n\\n**Always do:**\\n\\n- [rule]\\n\\n**Never do:**\\n\\n- [rule]\\n\\n**Tone:** [their style preference]\\n\\n**Stop and ask before:** [when to stop and ask]",
  "autonomy_map_rows_md": "One or more markdown table rows (no header) for their autonomy map. Bold any always-review rows. Use this column order: Scenario | L1 — Review all | L2 — Cautious | L3 — Smart default | L4+ — Auto. Example row: | Single-file edit | Draft → review | Auto if clear | Auto if clear | Auto |",
  "eval_rows_md": "One or more markdown table rows (no header) for their eval framework. Use this column order: Scenario | Input | Expected Output | Pass Threshold. Include a row for their biggest fear with 100% threshold."
}

Be specific and concrete — use their actual words where possible. Do not be generic.`;
}

// ---------------------------------------------------------------------------
// Apply to PATINA.md
// ---------------------------------------------------------------------------

/**
 * Insert content before the next section boundary (--- or ## N.) after the
 * given section header. Used as a fallback when a specific placeholder isn't found.
 */
export function insertBeforeSectionEnd(
  content: string,
  sectionHeader: string,
  insertion: string,
): string {
  const idx = content.indexOf(sectionHeader);
  if (idx === -1) return content;

  const after = content.slice(idx + sectionHeader.length);
  const boundaryMatch = after.match(/\n---\n|\n## \d+\./);
  if (!boundaryMatch || boundaryMatch.index === undefined) {
    return content + "\n" + insertion + "\n";
  }

  const insertAt = idx + sectionHeader.length + boundaryMatch.index;
  return content.slice(0, insertAt) + "\n" + insertion.trim() + "\n" + content.slice(insertAt);
}

/**
 * Apply onboarding to the core PATINA.md (behavior contract only).
 * Autonomy and eval data go to spoke files separately.
 */
export function applyOnboarding(content: string, response: OnboardingResponse): string {
  let result = content;

  // Replace Section 2 agent placeholder block with the generated behavior contract
  result = result.replace(
    /(\n## 2\. Behavior Contract\n\n)[\s\S]*?(?=\n## 3)/,
    `$1${response.behavior_contract_md.trim()}\n`,
  );

  // Autonomy and eval rows go to spoke files — handled in applyOnboardingToSpokes()
  return result;
}

/**
 * Replace all table body rows after the last |---| separator line with newRows.
 * Preserves the file header, prose, and table header/separator — only the data rows change.
 */
export function replaceTableBody(content: string, newRows: string): string {
  const lines = content.split("\n");
  let lastSepIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\|[-|: ]+\|$/.test(lines[i].trim())) {
      lastSepIdx = i;
      break;
    }
  }
  if (lastSepIdx === -1) {
    return content.trimEnd() + "\n" + newRows.trim() + "\n";
  }
  const kept = lines.slice(0, lastSepIdx + 1).join("\n");
  return kept + "\n" + newRows.trim() + "\n";
}

/**
 * Write autonomy map rows and eval framework rows to their respective spoke files,
 * replacing the default template rows rather than appending to them.
 */
export function applyOnboardingToSpokes(cwd: string, response: OnboardingResponse): void {
  ensureSpokeFiles(cwd);

  const autonomyPath = path.join(cwd, SPOKE_FILES["autonomy-detail"]);
  const autonomyContent = fs.readFileSync(autonomyPath, "utf-8");
  fs.writeFileSync(
    autonomyPath,
    replaceTableBody(autonomyContent, response.autonomy_map_rows_md),
    "utf-8",
  );

  const evalPath = path.join(cwd, SPOKE_FILES["eval-framework"]);
  const evalContent = fs.readFileSync(evalPath, "utf-8");
  fs.writeFileSync(evalPath, replaceTableBody(evalContent, response.eval_rows_md), "utf-8");
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function displayResults(response: OnboardingResponse): void {
  section("Summary");
  console.log(`  ${response.summary}`);

  section("Behavior Contract");
  response.behavior_contract_md.split("\n").forEach((l) => console.log(`  ${l}`));

  section("Autonomy Map rows");
  response.autonomy_map_rows_md.split("\n").forEach((l) => console.log(`  ${green("+")} ${l}`));

  section("Eval Framework rows");
  response.eval_rows_md.split("\n").forEach((l) => console.log(`  ${green("+")} ${l}`));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function onboardCommand(cwd: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  console.log(`\n${bold("patina run")} — first cycle setup`);
  console.log(hr());
  console.log(dim("  No prior cycles found. Let's set up your AI operating agreements."));
  console.log(dim("  9 questions across three frameworks (~10 min)."));
  console.log(
    dim(
      "  Evals define what good means → Behavior contracts encode it → Autonomy map enforces it.",
    ),
  );
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));

  const answers: Record<string, string> = {};
  let currentLabel = "";

  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];

    if (q.label && q.label !== currentLabel) {
      currentLabel = q.label;
      console.log(`\n${bold(cyan(q.label))}`);
      console.log(dim("─".repeat(q.label.length)));
    }

    const prefix = `${dim(`[${i + 1}/${QUESTIONS.length}]`)} ${bold(q.text)}\n> `;
    answers[q.key] = await ask(prefix);
    console.log();
  }

  rl.close();

  console.log(hr());
  console.log(`\n${bold("Sending to Claude...")}`);

  let response: OnboardingResponse;
  try {
    response = await callClaude(buildPrompt(answers));
  } catch (err) {
    console.error(
      `\n${red("Claude CLI call failed:")} ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.log(`\n${bold("Done.")}\n`);
  displayResults(response);

  // Confirm before writing
  const confirmRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ok = await new Promise<boolean>((resolve) => {
    confirmRl.question(`\n${hr()}\nApply this to ${LIVING_DOC_FILE}? [y/N] `, (a) => {
      confirmRl.close();
      resolve(a.trim().toLowerCase().startsWith("y"));
    });
  });

  if (!ok) {
    console.log(dim("Aborted. Run `patina run` to try again."));
    return;
  }

  // Read and populate PATINA.md
  const livingDocPath = path.join(cwd, LIVING_DOC_FILE);
  if (!fs.existsSync(livingDocPath)) {
    console.error(red(`${LIVING_DOC_FILE} not found. Run \`patina init\` first.`));
    process.exit(1);
  }

  const original = fs.readFileSync(livingDocPath, "utf-8");
  const populated = applyOnboarding(original, response);

  // Write autonomy and eval data to spoke files
  applyOnboardingToSpokes(cwd, response);

  // Update the "last updated" timestamp
  const dated = populated.replace(/> Last updated: .+/, `> Last updated: ${today}`);

  fs.writeFileSync(livingDocPath, dated, "utf-8");

  // Save cycle file
  const cycleContent = `# Onboarding Cycle — ${today}

> Generated by \`patina run\` (first cycle setup) on ${new Date().toISOString()}

---

## Summary

${response.summary}

---

## Behavior Contract

${response.behavior_contract_md}

---

## Autonomy Map (additions)

| Scenario | L1 — Review all | L2 — Cautious | L3 — Smart default | L4+ — Auto |
|---|---|---|---|---|
${response.autonomy_map_rows_md}

---

## Eval Framework (additions)

| Scenario | Input | Expected Output | Pass Threshold |
|---|---|---|---|
${response.eval_rows_md}

---

## Answers

${QUESTIONS.map((q) => `**${q.text}**\n\n${answers[q.key] || "_(no answer)_"}`).join("\n\n---\n\n")}
`;

  writeCycleFile(today, cycleContent, cwd);

  console.log();
  console.log(green("✓") + ` Applied to ${bold(LIVING_DOC_FILE)}`);
  console.log(green("✓") + `  Cycle report saved to ${dim(`.patina/cycles/${today}.md`)}`);
  console.log();
  console.log(
    dim("Your AI operating agreements are set. Run `patina run` after your next work cycle."),
  );
  console.log(dim(`Commit ${LIVING_DOC_FILE} to share with your team.`));
  console.log();
}
