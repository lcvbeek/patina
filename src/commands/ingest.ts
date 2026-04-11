import path from "path";
import {
  assertInitialised,
  sessionExists,
  writeSession,
  readConfig,
  type SessionSummary,
} from "../lib/storage.js";
import { discoverProjects, cwdToSlug, parseConversationFile } from "../lib/parser.js";
import { getGitAuthor } from "../lib/git.js";

export interface IngestOptions {
  claudeDir?: string;
  verbose?: boolean;
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
}
