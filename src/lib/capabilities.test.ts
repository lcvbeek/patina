import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// Mocks — must come before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("./storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage.js")>();
  return {
    ...actual,
    readConfig: vi.fn(),
    getDataDir: vi.fn(),
  };
});

import {
  fetchClaudeCapabilities,
  extractRecentEntries,
  readCapabilitiesConfig,
  CHANGELOG_URL,
} from "./capabilities.js";
import { readConfig, getDataDir } from "./storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "patina-capabilities-test-"));
}

function defaultConfig() {
  return { include: [], exclude: [], retroReminderAfterSessions: 10 };
}

function mockFetch(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  });
}

const SAMPLE_CHANGELOG = `# Changelog

## [2.1.0] - 2026-04-01

### Added
- New /tui command with fullscreen rendering
- Push notifications support

## [2.0.0] - 2026-03-01

### Changed
- Extended thinking improvements
`;

// ---------------------------------------------------------------------------
// extractRecentEntries
// ---------------------------------------------------------------------------

describe("extractRecentEntries", () => {
  it("starts from the first ## [ heading", () => {
    const result = extractRecentEntries(SAMPLE_CHANGELOG);
    expect(result).toContain("## [2.1.0]");
    expect(result).not.toContain("# Changelog");
  });

  it("returns full content when under MAX_CONTENT_CHARS", () => {
    const result = extractRecentEntries(SAMPLE_CHANGELOG);
    expect(result).toContain("## [2.0.0]");
  });

  it("caps output at 1200 chars and trims to complete line", () => {
    const longBody = "## [1.0.0]\n" + "- feature line\n".repeat(200);
    const result = extractRecentEntries(longBody);
    expect(result.length).toBeLessThanOrEqual(1200);
    // Should end at a line boundary (no trailing partial line)
    expect(result).not.toMatch(/- feature lin$/);
  });

  it("handles markdown with no ## [ heading", () => {
    const result = extractRecentEntries("just some plain text\nno headings here");
    expect(result).toContain("just some plain text");
  });
});

// ---------------------------------------------------------------------------
// readCapabilitiesConfig
// ---------------------------------------------------------------------------

describe("readCapabilitiesConfig", () => {
  beforeEach(() => {
    vi.mocked(readConfig).mockReturnValue(defaultConfig());
    vi.mocked(getDataDir).mockReturnValue(tmpDir);
  });

  it("returns defaults when config has no capabilities field", () => {
    const cfg = readCapabilitiesConfig("/any");
    expect(cfg.enabled).toBe(true);
    expect(cfg.ttlHours).toBe(24);
    expect(cfg.url).toBe(CHANGELOG_URL);
  });

  it("merges user config over defaults", () => {
    vi.mocked(readConfig).mockReturnValue({
      ...defaultConfig(),
      capabilities: { enabled: false, ttlHours: 6 },
    });
    const cfg = readCapabilitiesConfig("/any");
    expect(cfg.enabled).toBe(false);
    expect(cfg.ttlHours).toBe(6);
    expect(cfg.url).toBe(CHANGELOG_URL);
  });

  it("respects custom url", () => {
    vi.mocked(readConfig).mockReturnValue({
      ...defaultConfig(),
      capabilities: { url: "https://example.com/changelog" },
    });
    const cfg = readCapabilitiesConfig("/any");
    expect(cfg.url).toBe("https://example.com/changelog");
  });
});

// ---------------------------------------------------------------------------
// fetchClaudeCapabilities
// ---------------------------------------------------------------------------

describe("fetchClaudeCapabilities", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
    vi.mocked(readConfig).mockReturnValue(defaultConfig());
    vi.mocked(getDataDir).mockReturnValue(tmpDir);
    vi.stubGlobal("fetch", mockFetch(200, SAMPLE_CHANGELOG));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns null when capabilities.enabled is false", async () => {
    vi.mocked(readConfig).mockReturnValue({
      ...defaultConfig(),
      capabilities: { enabled: false },
    });
    const result = await fetchClaudeCapabilities(tmpDir);
    expect(result).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("fetches and caches when no cache exists", async () => {
    const result = await fetchClaudeCapabilities(tmpDir);
    expect(result).toContain("## Claude Code Recent Capabilities");
    expect(result).toContain("## [2.1.0]");

    // Cache was written
    const cacheFile = path.join(tmpDir, "cache", "capabilities.json");
    expect(fs.existsSync(cacheFile)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    expect(cached.content).toBe(result);
    expect(cached.url).toBe(CHANGELOG_URL);
  });

  it("returns cached content without fetching when cache is valid", async () => {
    // Seed the cache
    const cacheDir = path.join(tmpDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cachedContent = "## Claude Code Recent Capabilities (fetched 2026-01-01)\n- cached item";
    fs.writeFileSync(
      path.join(cacheDir, "capabilities.json"),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        content: cachedContent,
        url: CHANGELOG_URL,
      }),
      "utf-8",
    );

    const result = await fetchClaudeCapabilities(tmpDir);
    expect(result).toBe(cachedContent);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("fetches fresh content when cache is expired", async () => {
    // Seed an expired cache (25h ago)
    const cacheDir = path.join(tmpDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const staleDate = new Date(Date.now() - 25 * 3_600_000).toISOString();
    fs.writeFileSync(
      path.join(cacheDir, "capabilities.json"),
      JSON.stringify({
        fetchedAt: staleDate,
        content: "## Claude Code Recent Capabilities (fetched old)\n- stale item",
        url: CHANGELOG_URL,
      }),
      "utf-8",
    );

    const result = await fetchClaudeCapabilities(tmpDir);
    expect(result).toContain("## [2.1.0]");
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it("returns stale cache when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    // Seed a stale cache
    const cacheDir = path.join(tmpDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const staleDate = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const staleContent = "## Claude Code Recent Capabilities (fetched old)\n- stale item";
    fs.writeFileSync(
      path.join(cacheDir, "capabilities.json"),
      JSON.stringify({ fetchedAt: staleDate, content: staleContent, url: CHANGELOG_URL }),
      "utf-8",
    );

    const result = await fetchClaudeCapabilities(tmpDir);
    expect(result).toBe(staleContent);
  });

  it("returns null when no cache and fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await fetchClaudeCapabilities(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when fetch returns non-200", async () => {
    vi.stubGlobal("fetch", mockFetch(404, "not found"));
    const result = await fetchClaudeCapabilities(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when cache file is corrupted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const cacheDir = path.join(tmpDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "capabilities.json"), "not valid json {{", "utf-8");

    const result = await fetchClaudeCapabilities(tmpDir);
    expect(result).toBeNull();
  });
});
