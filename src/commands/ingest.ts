import path from "path";
import readline from "readline";
import {
  assertInitialised,
  sessionExists,
  writeSession,
  readCaptures,
  readConfig,
  getLatestCycleDate,
  getDataDir,
  type SessionSummary,
} from "../lib/storage.js";
import { discoverProjects, cwdToSlug, parseConversationFile } from "../lib/parser.js";
import { getGitAuthor } from "../lib/git.js";
import { captureCommand } from "./capture.js";
import { suggestCaptureFromSessions } from "../lib/capture-triggers.js";
import { shouldSync, gitPush } from "../lib/data-dir-git.js";

export interface IngestOptions {
  claudeDir?: string;
  verbose?: boolean;
}

export const terminal = {
  isInteractive: (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

async function maybeSuggestCapture(
  ingestedSessions: SessionSummary[],
  options: IngestOptions,
): Promise<void> {
  if (!terminal.isInteractive() || ingestedSessions.length === 0) return;

  try {
    const cwd = process.cwd();
    const lastCycleDate = getLatestCycleDate(cwd);
    const capturesThisCycle = readCaptures(cwd, lastCycleDate);
    const lastCaptureMs = capturesThisCycle.reduce<number | null>((max, c) => {
      const ts = new Date(c.timestamp).getTime();
      if (!Number.isFinite(ts)) return max;
      if (max === null) return ts;
      return Math.max(max, ts);
    }, null);

    const sessionsSinceLastCapture = lastCaptureMs
      ? ingestedSessions.filter((s) => {
          const ts = new Date(s.ingested_at).getTime();
          return Number.isFinite(ts) && ts > lastCaptureMs;
        })
      : ingestedSessions;

    const newestSessionMs = sessionsSinceLastCapture.reduce((max, s) => {
      const ts = new Date(s.timestamp).getTime();
      return Number.isFinite(ts) ? Math.max(max, ts) : max;
    }, 0);
    const isRecent = newestSessionMs > 0 && Date.now() - newestSessionMs < 1000 * 60 * 60 * 48;
    if (!isRecent) return;

    const suggestion = suggestCaptureFromSessions(sessionsSinceLastCapture);
    if (!suggestion) return;

    console.log(`\nCapture suggestion: ${suggestion.reason}`);
    console.log(
      `Run \`patina capture --tag ${suggestion.tag}\` to record what happened (a short, human-written summary).`,
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Capture now? (y/N) ", (a) => resolve(a.trim()));
    });
    rl.close();

    if (answer.toLowerCase().startsWith("y")) {
      await captureCommand(undefined, { tag: suggestion.tag });
    }
  } catch (err) {
    if (options.verbose) {
      console.warn(
        `Warning: skipping capture suggestion: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Core ingest logic — returns counts. Used by both ingestCommand and auto-ingest in patina run.
 */
export function runIngest(options: IngestOptions = {}): {
  ingested: number;
  skipped: number;
  errors: number;
} {
  const { include, exclude } = readConfig();
  const includeSlugs = [cwdToSlug(process.cwd()), ...include];
  const projects = discoverProjects(options.claudeDir, includeSlugs, exclude);

  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  for (const project of projects) {
    if (options.verbose) {
      console.log(`  Parsing: ${project.conversationFile}`);
    }

    let parsedSessions;
    try {
      parsedSessions = parseConversationFile(project.conversationFile, project.name);
    } catch (err) {
      if (options.verbose) {
        console.warn(
          `  Warning: failed to parse ${project.conversationFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      errors++;
      continue;
    }

    for (const parsed of parsedSessions) {
      if (sessionExists(parsed.session_id)) {
        skipped++;
        if (options.verbose) console.log(`    skip  ${parsed.session_id} (already ingested)`);
        continue;
      }
      const summary: SessionSummary = {
        ...parsed,
        ingested_at: new Date().toISOString(),
        author: getGitAuthor(),
        projectAlias: path.basename(process.cwd()),
      };
      try {
        writeSession(summary);
        ingested++;
        if (options.verbose)
          console.log(
            `    ingest ${parsed.session_id} (${parsed.turn_count} turns, ~${parsed.estimated_tokens.toLocaleString()} tokens)`,
          );
      } catch (err) {
        if (options.verbose)
          console.warn(
            `  Warning: failed to write session ${parsed.session_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        errors++;
      }
    }
  }

  return { ingested, skipped, errors };
}

export async function ingestCommand(options: IngestOptions = {}): Promise<void> {
  assertInitialised();

  const { include, exclude } = readConfig();
  const includeSlugs = [cwdToSlug(process.cwd()), ...include];
  const projects = discoverProjects(options.claudeDir, includeSlugs, exclude);

  if (projects.length === 0) {
    const dir = options.claudeDir ?? "~/.claude/projects/";
    console.log(`No Claude Code project logs found in ${dir}`);
    console.log(
      "Make sure you have run Claude Code at least once, or specify a different path with --claude-dir.",
    );
    return;
  }

  if (options.verbose) {
    console.log(`Found ${projects.length} conversation file(s) across projects.\n`);
  }

  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  const ingestedSessions: SessionSummary[] = [];

  for (const project of projects) {
    if (options.verbose) {
      console.log(`  Parsing: ${project.conversationFile}`);
    }

    let parsedSessions;
    try {
      parsedSessions = parseConversationFile(project.conversationFile, project.name);
    } catch (err) {
      console.warn(
        `  Warning: failed to parse ${project.conversationFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
      errors++;
      continue;
    }

    for (const parsed of parsedSessions) {
      if (sessionExists(parsed.session_id)) {
        skipped++;
        if (options.verbose) {
          console.log(`    skip  ${parsed.session_id} (already ingested)`);
        }
        continue;
      }

      const summary: SessionSummary = {
        ...parsed,
        ingested_at: new Date().toISOString(),
        author: getGitAuthor(),
        projectAlias: path.basename(process.cwd()),
      };

      try {
        writeSession(summary);
        ingested++;
        ingestedSessions.push(summary);
        if (options.verbose) {
          console.log(
            `    ingest ${parsed.session_id} (${parsed.turn_count} turns, ~${parsed.estimated_tokens.toLocaleString()} tokens)`,
          );
        }
      } catch (err) {
        console.warn(
          `  Warning: failed to write session ${parsed.session_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        errors++;
      }
    }
  }

  // Summary line
  const parts = [`${ingested} session(s) ingested`, `${skipped} skipped`];
  if (errors > 0) parts.push(`${errors} error(s)`);
  console.log(`\nDone. ${parts.join(", ")}.`);

  if (ingested > 0) {
    console.log("Run `patina status` to see metrics.");
  }

  await maybeSuggestCapture(ingestedSessions, options);
  if (ingested > 0) {
    const dataDir = getDataDir();
    if (shouldSync(readConfig(), dataDir)) {
      gitPush(dataDir, `ingest: ${new Date().toISOString().slice(0, 10)}`);
    }
  }
}
