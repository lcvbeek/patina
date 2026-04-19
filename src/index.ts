#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { initCommand } from "./commands/init.js";
import { ingestCommand } from "./commands/ingest.js";
import { statusCommand } from "./commands/status.js";
import { runCommand } from "./commands/run.js";
import { applyCommand } from "./commands/apply.js";
import { captureCommand } from "./commands/capture.js";
import { reflectCommand } from "./commands/reflect.js";
import { askCommand } from "./commands/ask.js";
import { layersCommand, DEFAULT_LIMIT as DEFAULT_LAYERS_LIMIT } from "./commands/layers.js";

const program = new Command();

program
  .name("patina")
  .description("AI-assisted retrospective tool for Claude Code teams")
  .version(pkg.version);

// ---------------------------------------------------------------------------
// patina init
// ---------------------------------------------------------------------------
program
  .command("init")
  .description("Scaffold .patina/ in the current directory and create PATINA.md")
  .option("--skill", "Also install the /patina Claude Code skill at ~/.claude/skills/patina/")
  .option("--data-repo <url>", "Clone a shared git repo as the dataDir and enable git sync")
  .action(async (options: { skill?: boolean; dataRepo?: string }) => {
    await initCommand(options);
  });

// ---------------------------------------------------------------------------
// patina ingest
// ---------------------------------------------------------------------------
program
  .command("ingest")
  .description("Parse ~/.claude/projects/ JSONL logs and store session summaries")
  .option(
    "--claude-dir <path>",
    "Override the Claude projects directory (default: ~/.claude/projects/)",
  )
  .option("-v, --verbose", "Print each session as it is ingested")
  .action(async (options: { claudeDir?: string; verbose?: boolean }) => {
    await ingestCommand({
      claudeDir: options.claudeDir,
      verbose: options.verbose,
    });
  });

// ---------------------------------------------------------------------------
// patina status
// ---------------------------------------------------------------------------
program
  .command("status")
  .description("Show metrics since the last cycle (or baseline if first run)")
  .action(async () => {
    await statusCommand();
  });

// ---------------------------------------------------------------------------
// patina run
// ---------------------------------------------------------------------------
program
  .command("run")
  .description("Start an async retrospective session with AI synthesis")
  .option("--onboard", "Run the framework-driven onboarding flow, even if prior cycles exist")
  .action(async (options: { onboard?: boolean }) => {
    await runCommand(options);
  });

// ---------------------------------------------------------------------------
// patina capture
// ---------------------------------------------------------------------------
program
  .command("capture [text]")
  .description("Capture a notable moment while it's fresh — feeds into your next retro")
  .option("-t, --tag <tag>", "near-miss | went-well | frustration | pattern | other")
  .option("-s, --synth", "immediately synthesise the captured moment with Claude")
  .action(async (text: string | undefined, options: { tag?: string; synth?: boolean }) => {
    await captureCommand(text, options);
  });

// ---------------------------------------------------------------------------
// patina reflect
// ---------------------------------------------------------------------------
program
  .command("reflect")
  .description("Record your reflections for the next retro — saved locally, loaded by patina run")
  .action(async () => {
    await reflectCommand();
  });

// ---------------------------------------------------------------------------
// patina ask
// ---------------------------------------------------------------------------
program
  .command("ask")
  .description("Answer one reflection question — micro-reflection for use in a Claude Code session")
  .option("--show", "Print the next unanswered question and exit")
  .option("--answer <text>", "Record an answer non-interactively")
  .option("--key <key>", "Target a specific question by key")
  .option("--json", "Emit machine-readable JSON output")
  .action(async (options: { show?: boolean; answer?: string; key?: string; json?: boolean }) => {
    await askCommand(options);
  });

// ---------------------------------------------------------------------------
// patina buff (primary) / patina apply (alias)
// ---------------------------------------------------------------------------
program
  .command("buff")
  .description(
    "[deprecated] patina run now applies changes automatically — kept for backwards compatibility",
  )
  .option("-y, --yes", "Apply without prompting")
  .action(async (options: { yes?: boolean }) => {
    await applyCommand(options);
  });

program
  .command("apply")
  .description(
    "[deprecated] patina run now applies changes automatically — kept for backwards compatibility",
  )
  .option("-y, --yes", "Apply without prompting")
  .action(async (options: { yes?: boolean }) => {
    await applyCommand(options);
  });

// ---------------------------------------------------------------------------
// patina layers
// ---------------------------------------------------------------------------
program
  .command("layers")
  .description("Visualise the patina you've built — one layer per retro cycle")
  .option("-n, --limit <n>", "number of layers to show (default: 5, 0 = all)")
  .action((opts: { limit?: string }) => {
    const limit = opts.limit !== undefined ? parseInt(opts.limit, 10) : DEFAULT_LAYERS_LIMIT;
    if (isNaN(limit)) {
      console.error("Error: --limit must be a number");
      process.exit(1);
    }
    layersCommand({ limit });
  });

// ---------------------------------------------------------------------------
// Parse and run
// ---------------------------------------------------------------------------
program.parseAsync(process.argv).catch((err: unknown) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
