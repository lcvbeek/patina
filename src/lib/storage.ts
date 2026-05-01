import fs from "fs";
import os from "os";
import path from "path";
import { z } from "zod";
import { estimateTokensFromChars } from "./token-estimate.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const PATINA_DIR = ".patina";
export const SESSIONS_DIR = path.join(PATINA_DIR, "sessions");
export const CYCLES_DIR = path.join(PATINA_DIR, "cycles");
export const CAPTURES_DIR = path.join(PATINA_DIR, "captures");
export const REFLECTIONS_DIR = path.join(PATINA_DIR, "reflections");
export const CONTEXT_DIR = path.join(PATINA_DIR, "context");
export const METRICS_FILE = path.join(PATINA_DIR, "metrics.json");
export const LIVING_DOC_FILE = path.join(PATINA_DIR, "PATINA.md");
export const OPPORTUNITY_BACKLOG_FILE = path.join(PATINA_DIR, "opportunity-backlog.md");
export const PATINA_CONFIG_FILE = path.join(PATINA_DIR, "config.json");
export const QUESTIONS_FILE = path.join(PATINA_DIR, "questions.json");

// ---------------------------------------------------------------------------
// Spoke files — on-demand context loaded only when relevant
// ---------------------------------------------------------------------------

export const SPOKE_FILES = {
  "autonomy-detail": path.join(CONTEXT_DIR, "autonomy-detail.md"),
  "incident-log": path.join(CONTEXT_DIR, "incident-log.md"),
  "eval-framework": path.join(CONTEXT_DIR, "eval-framework.md"),
  "cycle-history": path.join(CONTEXT_DIR, "cycle-history.md"),
} as const;

export type SpokeKey = keyof typeof SPOKE_FILES;

// Map section numbers to spoke files
const SECTION_TO_SPOKE: Record<number, SpokeKey> = {
  4: "autonomy-detail",
  5: "incident-log",
  6: "eval-framework",
  7: "cycle-history",
};

// Keyword fallback for section names without a number prefix
const KEYWORD_TO_SPOKE: Array<{ pattern: RegExp; key: SpokeKey }> = [
  { pattern: /incident/i, key: "incident-log" },
  { pattern: /eval/i, key: "eval-framework" },
  { pattern: /retro cycle|cycle history/i, key: "cycle-history" },
  { pattern: /autonomy.*detail/i, key: "autonomy-detail" },
];

/**
 * Hard limits for core PATINA.md to prevent context bloat.
 */
export const CORE_MAX_LINES = 80;
export const CORE_MAX_CHARS = 3200;

/**
 * Determine which file a proposed diff should target based on the section name.
 * Sections 1-3 → core PATINA.md, sections 4-7 → spoke files.
 */
export function resolveTargetFile(section: string, cwd = process.cwd()): string {
  const numMatch = section.match(/^(\d+)\./);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    const spokeKey = SECTION_TO_SPOKE[num];
    if (spokeKey) return path.join(cwd, SPOKE_FILES[spokeKey]);
  }

  for (const { pattern, key } of KEYWORD_TO_SPOKE) {
    if (pattern.test(section)) return path.join(cwd, SPOKE_FILES[key]);
  }

  return path.join(cwd, LIVING_DOC_FILE);
}

/**
 * Load all spoke files as a combined string for synthesis context.
 * Returns empty sections for files that don't exist yet.
 */
export function loadSpokeFiles(cwd = process.cwd()): string {
  const parts: string[] = [];

  for (const [key, relPath] of Object.entries(SPOKE_FILES)) {
    const absPath = path.join(cwd, relPath);
    if (fs.existsSync(absPath)) {
      const content = fs.readFileSync(absPath, "utf-8").trim();
      if (content) parts.push(content);
    } else {
      parts.push(`<!-- ${key}: no data yet -->`);
    }
  }

  return parts.join("\n\n");
}

/**
 * Load the opportunity backlog from .patina/opportunity-backlog.md.
 * Returns null if the file doesn't exist or is empty.
 */
export function loadOpportunityBacklog(cwd = process.cwd()): string | null {
  const absPath = path.join(cwd, OPPORTUNITY_BACKLOG_FILE);
  if (!fs.existsSync(absPath)) return null;
  const content = fs.readFileSync(absPath, "utf-8").trim();
  return content || null;
}

/**
 * Append a new opportunity entry to .patina/opportunity-backlog.md.
 * Creates the file with a header if it doesn't exist.
 */
export function appendOpportunity(
  cwd: string,
  opportunity: { observation: string; suggestion: string; effort: string },
): void {
  const absPath = path.join(cwd, OPPORTUNITY_BACKLOG_FILE);
  const today = new Date().toISOString().slice(0, 10);
  const entry = `- [ ] ${opportunity.suggestion} _(${opportunity.effort} effort, ${today})_\n  <!-- ${opportunity.observation} -->\n`;

  if (!fs.existsSync(absPath)) {
    fs.writeFileSync(absPath, OPPORTUNITY_BACKLOG_TEMPLATE + entry, "utf-8");
  } else {
    fs.appendFileSync(absPath, "\n" + entry, "utf-8");
  }
}

/**
 * Ensure the context directory and all spoke files exist.
 * Creates missing spoke files with their default templates.
 */
export function ensureSpokeFiles(cwd = process.cwd(), templates?: Record<SpokeKey, string>): void {
  ensureDir(path.join(cwd, CONTEXT_DIR));

  const defaults: Record<SpokeKey, string> = templates ?? {
    "autonomy-detail": AUTONOMY_DETAIL_TEMPLATE,
    "incident-log": INCIDENT_LOG_TEMPLATE,
    "eval-framework": EVAL_FRAMEWORK_TEMPLATE,
    "cycle-history": CYCLE_HISTORY_TEMPLATE,
  };

  for (const [key, relPath] of Object.entries(SPOKE_FILES)) {
    const absPath = path.join(cwd, relPath);
    if (!fs.existsSync(absPath)) {
      const template = defaults[key as SpokeKey] ?? "";
      fs.writeFileSync(absPath, template, "utf-8");
    }
  }
}

// ---------------------------------------------------------------------------
// Spoke file templates
// ---------------------------------------------------------------------------

export const AUTONOMY_DETAIL_TEMPLATE = `# Autonomy Map (Detail)

> Delegation preferences by scenario. Hard guardrails are in the core PATINA.md.
> Add rows for your common scenarios. Columns: what AI does at each trust level.

| Scenario | Supervised | Verify | Auto |
|---|---|---|---|
| Single-file edit, clear scope | Draft → review | Auto if unambiguous | Auto |
| Multi-file refactor | Draft → review | Draft → review | Auto with tests passing |
| New file creation | Draft → review | Draft → review | Auto |
`;

export const INCIDENT_LOG_TEMPLATE = `# Incident Log

> Brief entries when an agent causes a problem worth remembering.

| Date | What Happened | Root Cause | Fix Applied |
|---|---|---|---|
`;

export const EVAL_FRAMEWORK_TEMPLATE = `# Eval Framework

> What "good" looks like for each task type. Pass threshold: qualitative bar or measurable criterion.

| Scenario | Given | Expected | Pass |
|---|---|---|---|
| Refactor existing function | Specific scope, no new behaviour | Tests green, no API change | All tests pass |
`;

export const OPPORTUNITY_BACKLOG_TEMPLATE = `# Opportunity Backlog

> Improvement ideas — populated by \`patina run\`, reviewed each cycle.

`;

export const CYCLE_HISTORY_TEMPLATE = `# Retro Cycle History

> Auto-populated by \`patina run\`. Full cycle detail is preserved in .patina/cycles/.

| Cycle | Date | Key Insight | Change Made |
|---|---|---|---|
`;

export function patinaExists(cwd = process.cwd()): boolean {
  return fs.existsSync(path.join(cwd, PATINA_DIR));
}

export function assertInitialised(cwd = process.cwd()): void {
  if (!patinaExists(cwd)) {
    console.error("Error: .patina/ not found. Run `patina init` first.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Session summary schema
// ---------------------------------------------------------------------------

export const SessionSummarySchema = z.object({
  session_id: z.string(),
  project: z.string(),
  timestamp: z.string(), // ISO-8601
  turn_count: z.number().int().nonnegative(),
  estimated_tokens: z.number().int().nonnegative(),
  tool_calls: z.record(z.string(), z.number().int().nonnegative()),
  had_rework: z.boolean(),
  ingested_at: z.string(), // ISO-8601
  author: z.string().optional(), // git config user.name at ingest time
  projectAlias: z.string().optional(), // path.basename(cwd) — consistent across machines
  /** Real API token counts from JSONL usage fields. Optional for backward compat. */
  actualTokens: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cacheCreation: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative(),
    })
    .optional(),
  /** Context loaded at session start. Optional for backward compat. */
  contextSnapshot: z
    .object({
      systemPromptTokens: z.number().int().nonnegative(),
      mcpServers: z.array(z.string()),
      deferredTools: z.array(z.string()),
      model: z.string().optional(),
    })
    .optional(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// ---------------------------------------------------------------------------
// Metrics schema
// ---------------------------------------------------------------------------

export const MetricsSchema = z.object({
  last_updated: z.string(),
  cycles: z.array(
    z.object({
      cycle_id: z.string(),
      created_at: z.string(),
      session_count: z.number(),
      total_tokens: z.number(),
      rework_count: z.number(),
      synthesis_tokens: z.number().optional(),
      patina_md_tokens: z.number().optional(),
    }),
  ),
});

export type Metrics = z.infer<typeof MetricsSchema>;

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function readJson<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

export function sessionFilePath(sessionId: string, cwd = process.cwd()): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(getDataDir(cwd), "sessions", `${safe}.json`);
}

export function sessionExists(sessionId: string, cwd = process.cwd()): boolean {
  return fileExists(sessionFilePath(sessionId, cwd));
}

export function writeSession(summary: SessionSummary, cwd = process.cwd()): void {
  const validated = SessionSummarySchema.parse(summary);
  writeJson(sessionFilePath(summary.session_id, cwd), validated);
}

export function readAllSessions(cwd = process.cwd()): SessionSummary[] {
  const dir = path.join(getDataDir(cwd), "sessions");
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const sessions: SessionSummary[] = [];

  for (const file of files) {
    try {
      const raw = readJson<unknown>(path.join(dir, file));
      const parsed = SessionSummarySchema.safeParse(raw);
      if (parsed.success) {
        sessions.push(parsed.data);
      } else {
        console.warn(`Warning: skipping malformed session file: ${file}`);
      }
    } catch {
      console.warn(`Warning: could not read session file: ${file}`);
    }
  }

  return sessions;
}

export function readMetrics(cwd = process.cwd()): Metrics {
  const file = path.join(getDataDir(cwd), "metrics.json");
  if (!fileExists(file)) return { last_updated: new Date().toISOString(), cycles: [] };
  try {
    const raw = readJson<unknown>(file);
    return MetricsSchema.parse(raw);
  } catch {
    return { last_updated: new Date().toISOString(), cycles: [] };
  }
}

export function writeMetrics(metrics: Metrics, cwd = process.cwd()): void {
  const validated = MetricsSchema.parse(metrics);
  writeJson(path.join(getDataDir(cwd), "metrics.json"), validated);
}

export function readPatinaDocTokens(cwd = process.cwd()): number {
  const file = path.join(cwd, LIVING_DOC_FILE);
  if (!fs.existsSync(file)) return 0;
  return estimateTokensFromChars(fs.readFileSync(file, "utf-8").length);
}

// ---------------------------------------------------------------------------
// Patina config (.patina/config.json)
// ---------------------------------------------------------------------------

export interface PatinaConfig {
  /** Extra project slugs to ingest alongside the current project. Committed and team-shared. */
  include: string[];
  /** Slug substrings to exclude — takes precedence over include. Useful when include patterns are broad. */
  exclude?: string[];
  /**
   * Optional path to a shared data directory (resolved relative to cwd).
   * When set, sessions/reflections/captures/metrics are read from and written to this location.
   * Use this to share operational data with teammates via a dedicated repo or synced folder.
   * Example: "../patina-data"  (set automatically by `patina init --data-repo <url>`)
   */
  dataDir?: string;
  /**
   * Show a retro reminder nudge once this many sessions have accumulated since the last cycle.
   * Set to 0 to disable. Default: 10.
   */
  retroReminderAfterSessions?: number;
  /**
   * Controls fetching of Claude Code changelog for synthesis context.
   */
  capabilities?: {
    /** Fetch and inject Claude Code capabilities into the synthesis prompt. Default: true. */
    enabled?: boolean;
    /** Cache TTL in hours. Default: 24. */
    ttlHours?: number;
    /** URL to fetch. Default: Claude Code GitHub CHANGELOG. */
    url?: string;
  };
  /** Controls git sync behaviour for the dataDir.
   * "git"     → always run git pull/push around reads/writes
   * false     → never run git sync (explicit opt-out)
   * undefined → auto-detect: sync if dataDir is a git working tree
   */
  dataDirSync?: "git" | false;
}

const DEFAULT_CONFIG: PatinaConfig = {
  include: [],
  exclude: [],
  retroReminderAfterSessions: 10,
};

/**
 * Resolve the data directory for the given project.
 *
 * Priority:
 *   1. PATINA_DATA_DIR env var (testing / CI override)
 *   2. dataDir field in .patina/config.json (team shared store)
 *   3. ~/.patina/projects/<slug>/ (default: machine-local per-project)
 */
export function getDataDir(cwd = process.cwd()): string {
  if (process.env.PATINA_DATA_DIR) return process.env.PATINA_DATA_DIR;
  const config = readConfig(cwd);
  if (config.dataDir) {
    const expanded = config.dataDir.startsWith("~/")
      ? path.join(os.homedir(), config.dataDir.slice(2))
      : config.dataDir;
    return path.resolve(cwd, expanded);
  }
  const slug =
    "-" +
    cwd
      .split("/")
      .filter((p) => p)
      .join("-");
  return path.join(os.homedir(), ".patina", "projects", slug);
}

export function readConfig(cwd = process.cwd()): PatinaConfig {
  const file = path.join(cwd, PATINA_CONFIG_FILE);
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<PatinaConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Returns the number of sessions recorded since the last retro cycle,
 * along with the last cycle date. Used to surface retro reminder nudges.
 */
export function getSessionsInCycle(cwd = process.cwd()): {
  count: number;
  lastCycleDate: string | null;
} {
  const lastCycleDate = getLatestCycleDate(cwd);
  const all = readAllSessions(cwd);
  if (!lastCycleDate) return { count: all.length, lastCycleDate: null };
  const cutoff = new Date(lastCycleDate + "T00:00:00Z").getTime();
  const count = all.filter((s) => new Date(s.timestamp).getTime() > cutoff).length;
  return { count, lastCycleDate };
}

// ---------------------------------------------------------------------------
// Pending diff (staged proposal from patina run → consumed by patina diff/apply)
// ---------------------------------------------------------------------------

export interface PendingDiff {
  section: string;
  rationale: string;
  diff: string;
  timestamp: string; // ISO-8601
  opportunity?: {
    observation: string;
    suggestion: string;
    effort: "low" | "medium" | "high";
  };
}

export const PENDING_DIFF_FILE = path.join(PATINA_DIR, "pending-diff.json");

export function writePendingDiff(diff: PendingDiff, cwd = process.cwd()): void {
  writeJson(path.join(getDataDir(cwd), "pending-diff.json"), diff);
}

export function readPendingDiff(cwd = process.cwd()): PendingDiff | null {
  const file = path.join(getDataDir(cwd), "pending-diff.json");
  if (!fileExists(file)) return null;
  try {
    return readJson<PendingDiff>(file);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cycle file helpers
// ---------------------------------------------------------------------------

export function cycleFilePath(date: string, cwd = process.cwd()): string {
  return path.join(cwd, CYCLES_DIR, `${date}.md`);
}

export function getLatestCycleDate(cwd = process.cwd()): string | null {
  const dir = path.join(cwd, CYCLES_DIR);
  if (!fs.existsSync(dir)) return null;

  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();

  if (files.length === 0) return null;
  // Remove .md suffix to return just the date string
  return files[files.length - 1].replace(/\.md$/, "");
}

export function writeCycleFile(date: string, content: string, cwd = process.cwd()): void {
  const filePath = cycleFilePath(date, cwd);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Capture helpers (event-driven capture between retro cycles)
// ---------------------------------------------------------------------------

export const CAPTURE_TAGS = ["near-miss", "went-well", "frustration", "pattern", "other"] as const;
export type CaptureTag = (typeof CAPTURE_TAGS)[number];

export const CaptureSchema = z.object({
  id: z.string(),
  text: z.string(),
  tag: z.enum(CAPTURE_TAGS).optional(),
  author: z.string(),
  timestamp: z.string(), // ISO-8601
});

export type Capture = z.infer<typeof CaptureSchema>;

export function writeCapture(capture: Capture, cwd = process.cwd()): void {
  const validated = CaptureSchema.parse(capture);
  const safe = capture.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(getDataDir(cwd), "captures", `${safe}.json`);
  ensureDir(path.dirname(filePath));
  writeJson(filePath, validated);
}

// ---------------------------------------------------------------------------
// Reflection helpers (async per-person reflections, committed like captures)
// ---------------------------------------------------------------------------

export const ReflectionSchema = z.object({
  id: z.string(),
  author: z.string(),
  timestamp: z.string(), // ISO-8601
  cycleStart: z.string().nullable(), // lastCycleDate at time of reflection
  answers: z.record(z.string(), z.string()), // keyed by question key
});

export type Reflection = z.infer<typeof ReflectionSchema>;

export function writeReflection(reflection: Reflection, cwd = process.cwd()): void {
  const validated = ReflectionSchema.parse(reflection);
  const safe = reflection.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(getDataDir(cwd), "reflections", `${safe}.json`);
  ensureDir(path.dirname(filePath));
  writeJson(filePath, validated);
}

export function readReflections(cwd = process.cwd(), since?: string | null): Reflection[] {
  const dir = path.join(getDataDir(cwd), "reflections");
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const reflections: Reflection[] = [];

  for (const file of files) {
    try {
      const raw = readJson<unknown>(path.join(dir, file));
      const parsed = ReflectionSchema.safeParse(raw);
      if (parsed.success) {
        reflections.push(parsed.data);
      }
    } catch {
      console.warn(`Warning: skipping malformed reflection file: ${file}`);
    }
  }

  const sorted = reflections.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (since) {
    const cutoff = new Date(since + "T00:00:00Z").getTime();
    return sorted.filter((r) => new Date(r.timestamp).getTime() > cutoff);
  }

  return sorted;
}

export function readCaptures(cwd = process.cwd(), sinceDate?: string | null): Capture[] {
  const dir = path.join(getDataDir(cwd), "captures");
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const captures: Capture[] = [];

  for (const file of files) {
    try {
      const raw = readJson<unknown>(path.join(dir, file));
      const parsed = CaptureSchema.safeParse(raw);
      if (parsed.success) {
        captures.push(parsed.data);
      }
    } catch {
      console.warn(`Warning: skipping malformed capture file: ${file}`);
    }
  }

  const sorted = captures.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (sinceDate) {
    const cutoff = new Date(sinceDate + "T00:00:00Z").getTime();
    return sorted.filter((c) => new Date(c.timestamp).getTime() > cutoff);
  }

  return sorted;
}
