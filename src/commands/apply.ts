import fs from "fs";
import path from "path";
import readline from "readline";
import {
  assertInitialised,
  readPendingDiff,
  getDataDir,
  LIVING_DOC_FILE,
  SPOKE_FILES,
  CORE_MAX_LINES,
  CORE_MAX_CHARS,
  resolveTargetFile,
  ensureSpokeFiles,
  appendOpportunity,
} from "../lib/storage.js";
import { lintMarkdown, fixMarkdown } from "../lib/lint.js";

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

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

/**
 * Find the section header in PATINA.md and insert the diff text after it.
 * Falls back to appending at the end of the section if the header isn't found exactly.
 */
export function applyDiffToDoc(content: string, section: string, diffText: string): string {
  const lines = content.split("\n");

  // Try to find the matching section header (## 1. Working Agreements, etc.)
  // Match by number prefix or by full title (case-insensitive)
  const sectionLower = section.toLowerCase().trim();
  let sectionIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      line.startsWith("## ") &&
      line.toLowerCase().includes(sectionLower.replace(/^\d+\.\s*/, ""))
    ) {
      sectionIdx = i;
      break;
    }
    // Also match by number alone: "## 1." prefix
    const numMatch = sectionLower.match(/^(\d+)\./);
    if (numMatch && line.startsWith(`## ${numMatch[1]}.`)) {
      sectionIdx = i;
      break;
    }
  }

  if (sectionIdx === -1) {
    // Section not found — append before the last --- or at end
    const lastHrIdx = lines.lastIndexOf("---");
    const insertAt = lastHrIdx !== -1 ? lastHrIdx : lines.length;
    const newLines = [
      ...lines.slice(0, insertAt),
      "",
      `<!-- Added by patina apply ${new Date().toISOString().slice(0, 10)} -->`,
      ...diffText.split("\n"),
      "",
      ...lines.slice(insertAt),
    ];
    return newLines.join("\n");
  }

  // Find the end of this section (next ## heading, --- separator, or end of file)
  let sectionEnd = lines.length;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ") || lines[i].trim() === "---") {
      sectionEnd = i;
      break;
    }
  }

  // Find the last non-empty, non-comment line in the section to insert after
  let insertAfter = sectionEnd - 1;
  for (let i = sectionEnd - 1; i > sectionIdx; i--) {
    if (lines[i].trim() !== "" && !lines[i].trim().startsWith("<!--")) {
      insertAfter = i;
      break;
    }
  }

  const newLines = [
    ...lines.slice(0, insertAfter + 1),
    ...diffText.split("\n"),
    "",
    ...lines.slice(insertAfter + 1),
  ];

  return newLines.join("\n");
}

const CYCLE_HISTORY_CAP = 5;

/**
 * Update the Retro Cycle History table.
 * Operates on the cycle-history spoke file content (not the core PATINA.md).
 * Keeps at most CYCLE_HISTORY_CAP rows — oldest rows are dropped when the cap
 * is exceeded. Full cycle detail is preserved in .patina/cycles/.
 */
export function updateCycleHistory(content: string, insight: string, changeDesc: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const cycleCount = (content.match(/^\| \d+/gm) || []).length + 1;
  const newRow = `| ${cycleCount} | ${today} | ${insight.slice(0, 60)}... | ${changeDesc.slice(0, 50)}... |`;
  const placeholder = "| — | — | — | — |";

  let updated = content;

  if (updated.includes(placeholder)) {
    updated = updated.replace(placeholder, newRow);
  } else {
    // Append a new row at the end of the table
    const tableHeaderPattern = /\| Cycle \| Date \| Key Insight \| Change Made \|\n\|[-| ]+\|/;
    const headerMatch = updated.match(tableHeaderPattern);
    if (!headerMatch) {
      // No table found — append one
      updated = updated.trimEnd() + "\n" + newRow + "\n";
    } else {
      // Find the last table row and append after it
      const after = updated.slice(headerMatch.index ?? 0);
      const lastRowMatch = after.match(/(\| .+ \|\n?)(?!.*\| .+ \|)/s);
      if (lastRowMatch) {
        const insertPos =
          (headerMatch.index ?? 0) + after.indexOf(lastRowMatch[0]) + lastRowMatch[0].length;
        updated = updated.slice(0, insertPos) + newRow + "\n" + updated.slice(insertPos);
      }
    }
  }

  // Trim oldest rows if over cap
  const tableHeaderPattern2 = /\| Cycle \| Date \| Key Insight \| Change Made \|\n\|[-| ]+\|\n/;
  const headerMatch2 = updated.match(tableHeaderPattern2);
  if (headerMatch2) {
    const tableStart = headerMatch2.index! + headerMatch2[0].length;
    const afterTable = updated.slice(tableStart);
    const rowRegex = /^\| \d+ \|.+\|\n?/gm;
    const rows = [...afterTable.matchAll(rowRegex)];

    if (rows.length > CYCLE_HISTORY_CAP) {
      const excess = rows.length - CYCLE_HISTORY_CAP;
      const firstKeep = rows[excess].index!;
      updated = updated.slice(0, tableStart) + afterTable.slice(firstKeep);
    }
  }

  return updated;
}

/**
 * Update the cycle history spoke file on disk.
 */
export function updateCycleHistoryFile(cwd: string, insight: string, changeDesc: string): void {
  const spokeFile = path.join(cwd, SPOKE_FILES["cycle-history"]);
  let content = "";

  if (fs.existsSync(spokeFile)) {
    content = fs.readFileSync(spokeFile, "utf-8");
  } else {
    // Create with default template if missing
    ensureSpokeFiles(cwd);
    content = fs.readFileSync(spokeFile, "utf-8");
  }

  const updated = updateCycleHistory(content, insight, changeDesc);
  fs.writeFileSync(spokeFile, updated, "utf-8");
}

export async function applyCommand(options: { yes?: boolean } = {}): Promise<void> {
  assertInitialised();
  const cwd = process.cwd();

  const pending = readPendingDiff(cwd);

  if (!pending) {
    console.log(yellow("No pending diff found."));
    console.log(dim("Run `patina run` first to generate a retrospective."));
    return;
  }

  // Route diff to the correct file (core PATINA.md or a spoke file)
  const targetFilePath = resolveTargetFile(pending.section, cwd);
  const targetRelPath = path.relative(cwd, targetFilePath);
  const targetExists = fs.existsSync(targetFilePath);
  const isCore = targetFilePath === path.join(cwd, LIVING_DOC_FILE);

  console.log(`\n${bold("patina buff")} — proposed instruction change`);
  console.log(hr());
  console.log(`  Generated : ${dim(new Date(pending.timestamp).toLocaleString())}`);
  console.log(
    `  Target    : ${cyan(targetExists ? targetRelPath : targetRelPath + " (will be created)")}`,
  );
  console.log(`  Section   : ${cyan(pending.section)}`);
  console.log();

  console.log(bold("Rationale"));
  console.log(hr());
  console.log(`  ${pending.rationale}`);
  console.log();

  console.log(bold("Proposed addition"));
  console.log(hr());
  pending.diff.split("\n").forEach((line) => {
    console.log(`  ${green("+ " + line)}`);
  });
  console.log();

  const ok = options.yes || (await confirm(`Apply this change to ${targetRelPath}? [y/N] `));

  if (!ok) {
    console.log(dim("Aborted. Pending diff unchanged."));
    return;
  }

  // Ensure spoke files exist before applying
  ensureSpokeFiles(cwd);

  // Read or create target file
  let content = fs.existsSync(targetFilePath)
    ? fs.readFileSync(targetFilePath, "utf-8")
    : isCore
      ? "# AI Operating Constitution\n\n## 1. Working Agreements\n\n"
      : "";

  // Apply the diff and auto-fix common lint issues
  content = applyDiffToDoc(content, pending.section, pending.diff);
  content = fixMarkdown(content);
  fs.writeFileSync(targetFilePath, content, "utf-8");

  // Warn about any remaining lint issues
  const warnings = lintMarkdown(content);
  if (warnings.length > 0) {
    console.log(yellow("!") + ` ${warnings.length} markdown lint warning(s) in ${targetRelPath}:`);
    for (const w of warnings.slice(0, 5)) {
      console.log(dim(`    line ${w.line}: ${w.rule} — ${w.message}`));
    }
    if (warnings.length > 5) {
      console.log(
        dim(`    ... and ${warnings.length - 5} more. Run \`npm run lint:md\` for full report.`),
      );
    }
  }

  // Update cycle history in the spoke file
  updateCycleHistoryFile(cwd, pending.rationale, pending.diff.slice(0, 50));

  // Append opportunity to backlog
  if (pending.opportunity) {
    appendOpportunity(cwd, pending.opportunity);
  }

  // Update the "last updated" timestamp in core PATINA.md
  const livingDocPath = path.join(cwd, LIVING_DOC_FILE);
  if (fs.existsSync(livingDocPath)) {
    let coreContent = fs.readFileSync(livingDocPath, "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    coreContent = coreContent.replace(/> Last updated: .+/, `> Last updated: ${today}`);
    // Also match the old format
    coreContent = coreContent.replace(
      /> Maintained by `patina`\. Last updated: .+/,
      `> Last updated: ${today}`,
    );
    fs.writeFileSync(livingDocPath, coreContent, "utf-8");

    // Enforce hard cap on core PATINA.md
    const coreLines = coreContent.split("\n");
    const coreChars = coreContent.length;
    if (coreLines.length > CORE_MAX_LINES || coreChars > CORE_MAX_CHARS) {
      console.log(
        yellow("!") +
          `  Core PATINA.md exceeds limits (${coreLines.length} lines / ${coreChars} chars).` +
          `  Cap: ${CORE_MAX_LINES} lines / ${CORE_MAX_CHARS} chars.` +
          `  Consider pruning stale entries or moving detail to spoke files.`,
      );
    }
  }

  // Clear pending diff
  const pendingDiffPath = path.join(getDataDir(cwd), "pending-diff.json");
  if (fs.existsSync(pendingDiffPath)) fs.unlinkSync(pendingDiffPath);

  // Update metrics.json with cycle count
  const metricsPath = path.join(getDataDir(cwd), "metrics.json");
  if (fs.existsSync(metricsPath)) {
    try {
      const metrics = JSON.parse(fs.readFileSync(metricsPath, "utf-8")) as Record<string, unknown>;
      metrics.cycles_completed = ((metrics.cycles_completed as number) || 0) + 1;
      metrics.last_apply = new Date().toISOString();
      fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2) + "\n", "utf-8");
    } catch {
      /* non-fatal */
    }
  }

  console.log();
  console.log(green("✓") + ` Applied to ${bold(targetRelPath)}`);
  console.log(green("✓") + " Cycle history updated");
  if (pending.opportunity) {
    console.log(green("✓") + " Opportunity added to .patina/opportunity-backlog.md");
  }
  console.log(green("✓") + " Pending diff cleared");
  console.log();
  console.log(dim(`Next: review ${targetRelPath} to confirm the change looks right.`));
  console.log(
    dim("Run `patina capture` anytime during your next cycle to record notable moments."),
  );
  console.log();
}
