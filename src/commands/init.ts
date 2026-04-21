import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { spawnSync } from "child_process";
import {
  PATINA_DIR,
  CYCLES_DIR,
  LIVING_DOC_FILE,
  OPPORTUNITY_BACKLOG_FILE,
  OPPORTUNITY_BACKLOG_TEMPLATE,
  PATINA_CONFIG_FILE,
  QUESTIONS_FILE,
  getDataDir,
  readConfig,
  patinaExists,
  ensureDir,
  writeJson,
  ensureSpokeFiles,
} from "../lib/storage.js";
import { PUBLIC_QUESTIONS } from "../lib/questions.js";
import { cwdToSlug } from "../lib/parser.js";
import { estimateTextTokens } from "../lib/token-estimate.js";
import { PATINA_SKILL_TEMPLATE } from "../templates/skill.js";
import { ensureDataDirGitignore } from "../lib/data-dir-git.js";

// ---------------------------------------------------------------------------
// Living-doc template — slim core (~55 lines, ~500 tokens)
// Sections 4-7 live in .patina/context/ as spoke files (loaded on demand).
// ---------------------------------------------------------------------------

const LIVING_DOC_TEMPLATE = `# AI Operating Constitution

> Last updated: ${new Date().toISOString().split("T")[0]}

## 1. Working Agreements

- Scope: Stay on task. Flag scope creep.
- Approval: Prod config, secrets, external APIs need human sign-off.
- Context: Targeted reads. Delegate narrow subtasks.
- Naming: Follow conventions. No new patterns without discussion.

## 2. Behavior Contract

**Always do:**

- Confirm plan before code; state scope in one sentence
- Follow existing style and conventions
- After changes, flag likely affected callsites

**Never do:**

- Irreversible/external actions without confirmation (push, deploy, API writes, emails)
- Proceed past hard-to-revert steps without pausing
- Add features, refactor, or "improve" beyond what was asked

**Tone:** Terse. No preamble ("I'll now…", "Sure!"). Action first; explain only if outcome is unexpected. No end-of-task summaries.

**Stop and ask before:** Anything expensive to undo, external, or public-facing.

## 3. Hard Guardrails

| Action | Rule |
|---|---|
| Push/publish/deploy | Human approval |
| Email or external message | Human approval |
| API write (POST/PUT/DELETE) | Human approval |
| Destructive op (delete/reset/force-push) | Human approval |

<!-- Extended context (read when relevant):
  .patina/context/autonomy-detail.md — full autonomy map with routine scenarios
  .patina/context/incident-log.md — past agent incidents
  .patina/context/eval-framework.md — eval criteria and pass thresholds
  .patina/context/cycle-history.md — retro cycle history
-->
`;

function coreEstimateLabel(content: string): string {
  const estimate = estimateTextTokens(content);
  return `core: ~${estimate.estimatedTokens.toLocaleString()} tokens (${estimate.lines} lines / ${estimate.chars.toLocaleString()} chars)`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** Scaffold ~/.claude/skills/patina/SKILL.md alongside project init. */
  skill?: boolean;
  /** Clone a shared git repo as the dataDir and enable git sync. */
  dataRepo?: string;
}

// ---------------------------------------------------------------------------
// data-repo helper
// ---------------------------------------------------------------------------


/**
 * Clone the remote repo as a sibling directory (../<repo-name>/), write .gitignore,
 * and update .patina/config.json with a portable relative dataDir.
 */
async function initDataRepo(repoUrl: string, cwd: string): Promise<void> {
  const repoName = repoUrl.replace(/\.git$/, "").split("/").at(-1)!;
  const clonePath = path.join(cwd, "..", repoName);
  const relativeDataDir = `../${repoName}`;

  if (fs.existsSync(clonePath)) {
    console.log(`\nData repo already exists at ${clonePath}`);
    console.log(`Updating .patina/config.json to point at it.`);
  } else {
    console.log(`\nCloning ${repoUrl}`);
    console.log(`  → ${clonePath}\n`);
    const result = spawnSync("git", ["clone", repoUrl, clonePath], { stdio: "inherit" });
    if (result.status !== 0) {
      console.error(`\nError: git clone failed. Check the URL and your access permissions.`);
      process.exit(1);
    }
  }

  ensureDataDirGitignore(clonePath);

  const existingConfig = readConfig(cwd);
  writeJson(path.join(cwd, PATINA_CONFIG_FILE), {
    ...existingConfig,
    dataDir: relativeDataDir,
  });

  console.log(`\n  Data repo  ${clonePath}`);
  console.log(`  Config     .patina/config.json  (dataDir: "${relativeDataDir}")`);
  console.log(`\nNext steps:`);
  console.log(`  patina ingest    — import your sessions and push to shared repo`);
  console.log(`  Share the repo URL with teammates: ${repoUrl}`);
  console.log(`  Each teammate runs: patina init --data-repo ${repoUrl}`);
}

/**
 * Install the /patina Claude Code skill at ~/.claude/skills/patina/SKILL.md.
 * Returns the resulting status so callers can log it.
 */
function installPatinaSkill(): "created" | "exists" {
  const skillDir = path.join(os.homedir(), ".claude", "skills", "patina");
  const skillPath = path.join(skillDir, "SKILL.md");
  if (fs.existsSync(skillPath)) return "exists";
  ensureDir(skillDir);
  fs.writeFileSync(skillPath, PATINA_SKILL_TEMPLATE, "utf-8");
  return "created";
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  const cwd = process.cwd();

  if (options.dataRepo) {
    await initDataRepo(options.dataRepo, cwd);
  }

  if (patinaExists(cwd)) {
    // --skill on an already-initialised project: install the skill only,
    // don't touch PATINA.md or prompt for overwrite.
    if (options.skill) {
      const skillStatus = installPatinaSkill();
      const skillPath = path.join("~", ".claude", "skills", "patina", "SKILL.md");
      if (skillStatus === "created") {
        console.log(`  Created  ${skillPath}  (/patina skill — use inside Claude Code sessions)`);
      } else {
        console.log(`  Skipped  ${skillPath}  (already exists)`);
      }
      return;
    }

    const livingDocPath = path.join(cwd, LIVING_DOC_FILE);
    const docExists = fs.existsSync(livingDocPath);

    if (!docExists) {
      fs.writeFileSync(livingDocPath, LIVING_DOC_TEMPLATE, "utf-8");
      console.log(`  Created  ${LIVING_DOC_FILE}  (${coreEstimateLabel(LIVING_DOC_TEMPLATE)})`);
      return;
    }

    console.log(`\n.patina/ already exists in ${cwd}`);
    console.log(`\nThis will replace ${LIVING_DOC_FILE} with the default template.`);
    console.log(`Your current PATINA.md will be lost.\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Type "overwrite" to confirm, or press Enter to cancel: `, resolve);
    });
    rl.close();

    if (answer.trim() !== "overwrite") {
      console.log("\nAborted. Nothing was changed.");
      process.exit(0);
    }

    fs.writeFileSync(livingDocPath, LIVING_DOC_TEMPLATE, "utf-8");
    console.log(
      `\n  Reset  ${LIVING_DOC_FILE}  to default template (${coreEstimateLabel(LIVING_DOC_TEMPLATE)})`,
    );
    console.log(
      `\nNext steps:\n  patina ingest   — parse Claude Code session logs\n  patina status   — view metrics`,
    );
    return;
  }

  // Create directory structure (constitution only — data dirs created lazily in ~/.patina/)
  ensureDir(path.join(cwd, CYCLES_DIR));

  // Create spoke files in .patina/context/
  ensureSpokeFiles(cwd);

  // Create opportunity backlog at .patina/opportunity-backlog.md
  const backlogPath = path.join(cwd, OPPORTUNITY_BACKLOG_FILE);
  if (!fs.existsSync(backlogPath)) {
    fs.writeFileSync(backlogPath, OPPORTUNITY_BACKLOG_TEMPLATE, "utf-8");
  }

  // Scaffold questions.json with the defaults (edit to customise)
  const questionsPath = path.join(cwd, QUESTIONS_FILE);
  if (!fs.existsSync(questionsPath)) {
    fs.writeFileSync(questionsPath, JSON.stringify(PUBLIC_QUESTIONS, null, 2) + "\n", "utf-8");
  }

  // Create PATINA.md (slim core — spoke files hold sections 4-7)
  const livingDocPath = path.join(cwd, LIVING_DOC_FILE);
  fs.writeFileSync(livingDocPath, LIVING_DOC_TEMPLATE, "utf-8");

  // Create config.json — auto-include the current project's Claude Code slug
  writeJson(path.join(cwd, PATINA_CONFIG_FILE), {
    include: [cwdToSlug(cwd)],
  });

  // Wire PATINA.md into CLAUDE.md so agents read it automatically
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  const importLine = `@${LIVING_DOC_FILE}`;
  let claudeMdStatus: "created" | "updated" | "skipped";

  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, "utf-8");
    if (existing.includes(importLine)) {
      claudeMdStatus = "skipped";
    } else {
      fs.writeFileSync(claudeMdPath, existing.trimEnd() + `\n\n${importLine}\n`, "utf-8");
      claudeMdStatus = "updated";
    }
  } else {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${importLine}\n`, "utf-8");
    claudeMdStatus = "created";
  }

  const dataDir = getDataDir(cwd);

  console.log(`Initialised patina in ${cwd}\n`);
  console.log(`  Created  ${PATINA_DIR}/`);
  console.log(`  Created  ${CYCLES_DIR}/`);
  console.log(`  Created  ${LIVING_DOC_FILE}  (${coreEstimateLabel(LIVING_DOC_TEMPLATE)})`);
  console.log(
    `  Created  ${OPPORTUNITY_BACKLOG_FILE}  (opportunity backlog — grows with each cycle)`,
  );
  console.log(`  Created  ${QUESTIONS_FILE}  (reflect questions — edit to customise)`);
  console.log(`  Created  .patina/context/  (spoke files — loaded on demand)`);
  console.log(
    `  Created  ${PATINA_CONFIG_FILE}  (add slugs to "include"; set "dataDir" for team sharing)`,
  );
  console.log(`  Data dir  ${dataDir}`);
  console.log(`            (sessions, reflections, captures, metrics — never committed)`);
  if (claudeMdStatus === "created") {
    console.log(`  Created  CLAUDE.md  (imports PATINA.md)`);
  } else if (claudeMdStatus === "updated") {
    console.log(`  Updated  CLAUDE.md  (added import of PATINA.md)`);
  }

  const skillStatus = installPatinaSkill();
  const skillPath = path.join("~", ".claude", "skills", "patina", "SKILL.md");
  if (skillStatus === "created") {
    console.log(`  Created  ${skillPath}  (/patina skill — use inside Claude Code sessions)`);
  } else {
    console.log(`  Skipped  ${skillPath}  (already exists)`);
  }

  console.log(
    `\nNext steps:\n  patina ingest   — parse Claude Code session logs\n  patina status   — view metrics`,
  );
}
