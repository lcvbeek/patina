/**
 * Fetches Claude Code capabilities from the GitHub CHANGELOG.
 *
 * Results are cached to disk with a configurable TTL (default 24h).
 * All errors degrade silently — callers receive null when unavailable.
 */

import path from "path";
import { fileExists, getDataDir, readConfig, readJson, writeJson } from "./storage.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHANGELOG_URL =
  "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";

const CAPABILITIES_CACHE_FILE = "cache/capabilities.json";
const MAX_CONTENT_CHARS = 1200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CapabilitiesCache {
  fetchedAt: string;
  content: string;
  url: string;
}

interface CapabilitiesConfig {
  enabled: boolean;
  ttlHours: number;
  url: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function readCapabilitiesConfig(cwd = process.cwd()): CapabilitiesConfig {
  const raw = readConfig(cwd);
  return {
    enabled: raw.capabilities?.enabled ?? true,
    ttlHours: raw.capabilities?.ttlHours ?? 24,
    url: raw.capabilities?.url ?? CHANGELOG_URL,
  };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function cachePath(cwd: string): string {
  return path.join(getDataDir(cwd), CAPABILITIES_CACHE_FILE);
}

function readCache(cwd: string): CapabilitiesCache | null {
  const file = cachePath(cwd);
  if (!fileExists(file)) return null;
  try {
    return readJson<CapabilitiesCache>(file);
  } catch {
    return null;
  }
}

function writeCache(cwd: string, cache: CapabilitiesCache): void {
  try {
    writeJson(cachePath(cwd), cache);
  } catch {
    // Non-fatal: if we can't write the cache the fetch still succeeded
  }
}

function isCacheValid(cache: CapabilitiesCache, ttlHours: number): boolean {
  const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();
  return ageMs < ttlHours * 3_600_000;
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Trim raw CHANGELOG markdown to the first MAX_CONTENT_CHARS chars,
 * starting from the first release heading, and snapping to a complete line.
 */
export function extractRecentEntries(markdown: string): string {
  const headingIndex = markdown.indexOf("## [");
  const body = headingIndex !== -1 ? markdown.slice(headingIndex) : markdown;

  if (body.length <= MAX_CONTENT_CHARS) return body.trim();

  const truncated = body.slice(0, MAX_CONTENT_CHARS);
  const lastNewline = truncated.lastIndexOf("\n");
  return (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated).trim();
}

function formatCapabilitiesBlock(content: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `## Claude Code Recent Capabilities (fetched ${date})\n${content}`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns a formatted capabilities section for the synthesis prompt,
 * or null if disabled, unavailable, or fetch fails.
 */
export async function fetchClaudeCapabilities(cwd = process.cwd()): Promise<string | null> {
  const config = readCapabilitiesConfig(cwd);
  if (!config.enabled) return null;

  const cached = readCache(cwd);
  if (cached && isCacheValid(cached, config.ttlHours)) {
    return cached.content;
  }

  try {
    const response = await fetch(config.url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const markdown = await response.text();
    const content = formatCapabilitiesBlock(extractRecentEntries(markdown));

    writeCache(cwd, {
      fetchedAt: new Date().toISOString(),
      content,
      url: config.url,
    });

    return content;
  } catch {
    // Degrade gracefully: return stale cache if available, else null
    return cached ? cached.content : null;
  }
}
