import fs from "fs";
import path from "path";
import { assertInitialised, CYCLES_DIR } from "../lib/storage.js";

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
function brightGreen(s: string) {
  return isTTY ? `\x1b[92m${s}\x1b[0m` : s;
}
function cyan(s: string) {
  return isTTY ? `\x1b[36m${s}\x1b[0m` : s;
}
function yellow(s: string) {
  return isTTY ? `\x1b[33m${s}\x1b[0m` : s;
}
function gold(s: string) {
  return isTTY ? `\x1b[93m${s}\x1b[0m` : s;
}
function red(s: string) {
  return isTTY ? `\x1b[31m${s}\x1b[0m` : s;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface LayerData {
  date: string;
  summary: string;
  sessions?: number;
  avgTokens?: number;
  reworkPct?: number;
  isOnboarding: boolean;
  sectionChanged?: string;
}

export function parseCycleFile(content: string, date: string): LayerData {
  const isOnboarding = content.includes("(first cycle setup)");

  const summaryMatch = content.match(/## (?:Cycle )?Summary\n+([^\n]+)/);
  const raw = summaryMatch ? summaryMatch[1].trim() : "";
  const summary = raw.length > 72 ? raw.slice(0, 72) + "…" : raw;

  const sessionsMatch = content.match(/\| Total sessions \| (\d+) \|/);
  const tokensMatch = content.match(/\| Avg tokens\/session \| ([\d,]+) \|/);
  const reworkMatch = content.match(/\| Sessions with rework \| \d+ \((\d+(?:\.\d+)?)%\) \|/);
  const sectionMatch = content.match(/\*\*Section:\*\* ([^\n]+)/);

  return {
    date,
    summary,
    sessions: sessionsMatch ? parseInt(sessionsMatch[1], 10) : undefined,
    avgTokens: tokensMatch ? parseInt(tokensMatch[1].replace(/,/g, ""), 10) : undefined,
    reworkPct: reworkMatch ? parseFloat(reworkMatch[1]) : undefined,
    isOnboarding,
    sectionChanged: sectionMatch ? sectionMatch[1].trim() : undefined,
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers (exported for tests)
// ---------------------------------------------------------------------------

// Legacy export kept for backward compatibility
export const BAND_WIDTH = 52;

export function tokenBar(avgTokens: number, maxTokens: number): string {
  const BARS = 16;
  const filled = Math.max(1, Math.round((avgTokens / maxTokens) * BARS));
  const empty = BARS - filled;
  return "▕" + "█".repeat(filled) + dim("░".repeat(empty)) + "▏";
}

export function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

export function deltaLabel(current: number, prior: number): string {
  const pct = Math.round(((current - prior) / prior) * 100);
  if (pct === 0) return "";
  if (pct < 0) return green(`↓${Math.abs(pct)}%`);
  return red(`↑${pct}%`);
}

// ---------------------------------------------------------------------------
// New side-by-side layout helpers
// ---------------------------------------------------------------------------

// Band column: 20 glyphs × 2 chars ("▓ ") = 40 display chars
const BAND_GLYPHS = 20;
const BAND_COLS = BAND_GLYPHS * 2; // 40

// Assign texture char + color based on position (idx 0 = oldest, total-1 = newest)
function getLayerStyle(
  idx: number,
  total: number,
): { char: string; colorFn: (s: string) => string } {
  const fromNewest = total - 1 - idx;
  if (fromNewest === 0) return { char: "·", colorFn: brightGreen };
  if (fromNewest === 1) return { char: "░", colorFn: green };
  if (fromNewest === 2) return { char: "▒", colorFn: green };
  if (fromNewest === 3) return { char: "▓", colorFn: yellow };
  return { char: "▓", colorFn: dim };
}

function reworkColor(pct: number): (s: string) => string {
  if (pct <= 10) return green;
  if (pct <= 18) return yellow;
  return red;
}

function tokenDeltaStr(current: number, prior: number | undefined): string {
  if (prior === undefined) return "";
  const pct = Math.round(((current - prior) / prior) * 100);
  if (pct === 0) return "";
  if (pct < 0) return green(`↓${Math.abs(pct)}% tokens`);
  return red(`↑${pct}% tokens`);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const DEFAULT_LIMIT = 5;

export function layersCommand(opts: { limit?: number } = {}): void {
  assertInitialised();

  const cwd = process.cwd();
  const cyclesDir = path.join(cwd, CYCLES_DIR);

  if (!fs.existsSync(cyclesDir)) {
    console.log("No layers yet. Run `patina run` to start building.");
    return;
  }

  const allFiles = fs
    .readdirSync(cyclesDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const files = limit === 0 ? allFiles : allFiles.slice(-limit);

  if (files.length === 0) {
    console.log("No layers yet. Run `patina run` to start building.");
    return;
  }

  const layers: LayerData[] = files.map((f) => {
    const date = f.replace(".md", "");
    const content = fs.readFileSync(path.join(cyclesDir, f), "utf-8");
    return parseCycleFile(content, date);
  });

  // Render newest first
  const reversed = [...layers].reverse();

  // Indent padding to align info column with start of text after band
  const INFO_PAD = " ".repeat(BAND_COLS + 2); // band + gap

  console.log();

  for (let i = 0; i < reversed.length; i++) {
    const layer = reversed[i];
    const layerIdx = layers.length - 1 - i; // 0 = oldest
    const { char, colorFn } = getLayerStyle(layerIdx, layers.length);
    const num = layerIdx + 1;

    const band = colorFn((char + " ").repeat(BAND_GLYPHS));

    // Row 1: band + layer header
    console.log(`  ${band}  ${dim(`Layer ${num} · ${layer.date}`)}`);

    // Row 2: summary
    if (layer.isOnboarding) {
      console.log(`  ${INFO_PAD}${dim("foundation — onboarding cycle")}`);
    } else if (layer.summary) {
      console.log(`  ${INFO_PAD}${bold(layer.summary)}`);
    }

    // Row 3: stats
    if (!layer.isOnboarding && layer.sessions !== undefined) {
      const older = reversed[i + 1]; // next in reversed = one layer older
      const parts: string[] = [];

      parts.push(dim(`${layer.sessions} sessions`));

      if (layer.avgTokens !== undefined) {
        parts.push(dim(`${formatK(layer.avgTokens)} avg tokens`));
        const delta = tokenDeltaStr(layer.avgTokens, older?.avgTokens);
        if (delta) parts.push(delta);
      }

      if (layer.reworkPct !== undefined) {
        const colorFnRework = reworkColor(layer.reworkPct);
        parts.push(colorFnRework(`${layer.reworkPct}% rework`));
      }

      console.log(`  ${INFO_PAD}${parts.join("  ")}`);
    }

    // Divider between layers (not after last)
    if (i < reversed.length - 1) {
      console.log(dim(`  ${"─".repeat(BAND_COLS + 50)}`));
    }
  }

  console.log();
}
