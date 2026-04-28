import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from "child_process";
import { isGitRepo, gitPull, gitPush, shouldSync } from "./data-dir-git.js";
import type { PatinaConfig } from "./storage.js";

const DATA_DIR = "/fake/data-dir";

function mockSpawn(status: number, stderr = ""): ReturnType<typeof vi.fn> {
  return vi.mocked(spawnSync).mockReturnValue({
    status,
    stderr,
    stdout: "",
    pid: 1,
    output: [],
    signal: null,
    error: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function mockSpawnSequence(calls: Array<{ status: number; stderr?: string }>): void {
  let callIndex = 0;
  vi.mocked(spawnSync).mockImplementation(() => {
    const call = calls[callIndex] ?? { status: 0 };
    callIndex++;
    return {
      status: call.status,
      stderr: call.stderr ?? "",
      stdout: "",
      pid: 1,
      output: [],
      signal: null,
      error: undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// isGitRepo
// ---------------------------------------------------------------------------

describe("isGitRepo", () => {
  it("returns true when git rev-parse exits 0", () => {
    mockSpawn(0);
    expect(isGitRepo(DATA_DIR)).toBe(true);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      expect.objectContaining({ cwd: DATA_DIR }),
    );
  });

  it("returns false when git rev-parse exits non-zero", () => {
    mockSpawn(128, "not a git repo");
    expect(isGitRepo(DATA_DIR)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldSync
// ---------------------------------------------------------------------------

describe("shouldSync", () => {
  it('returns true when dataDirSync is "git" regardless of git presence', () => {
    const config: PatinaConfig = { include: [], dataDirSync: "git" };
    // spawnSync should not be called at all
    expect(shouldSync(config, DATA_DIR)).toBe(true);
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it("returns false when dataDirSync is false regardless of git presence", () => {
    const config: PatinaConfig = { include: [], dataDirSync: false };
    expect(shouldSync(config, DATA_DIR)).toBe(false);
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it("returns true when dataDirSync is undefined and dir is a git repo", () => {
    const config: PatinaConfig = { include: [] };
    mockSpawn(0);
    expect(shouldSync(config, DATA_DIR)).toBe(true);
  });

  it("returns false when dataDirSync is undefined and dir is not a git repo", () => {
    const config: PatinaConfig = { include: [] };
    mockSpawn(128);
    expect(shouldSync(config, DATA_DIR)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gitPull
// ---------------------------------------------------------------------------

describe("gitPull", () => {
  it("returns success when fetch and reset both succeed", () => {
    mockSpawnSequence([{ status: 0 }, { status: 0 }]);
    const result = gitPull(DATA_DIR);
    expect(result.success).toBe(true);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(2);
  });

  it("warns and returns failure when fetch fails, does not throw", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSpawn(1, "network error");

    let result: ReturnType<typeof gitPull>;
    expect(() => {
      result = gitPull(DATA_DIR);
    }).not.toThrow();

    expect(result!.success).toBe(false);
    expect(result!.message).toContain("git fetch failed");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("git fetch failed"));
    warnSpy.mockRestore();
  });

  it("warns and returns failure when reset fails after successful fetch", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSpawnSequence([{ status: 0 }, { status: 1, stderr: "reset failed" }]);

    const result = gitPull(DATA_DIR);

    expect(result.success).toBe(false);
    expect(result.message).toContain("git reset failed");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("passes the data dir as cwd, not process cwd", () => {
    mockSpawnSequence([{ status: 0 }, { status: 0 }]);
    gitPull(DATA_DIR);
    for (const call of vi.mocked(spawnSync).mock.calls) {
      expect(call[2]).toMatchObject({ cwd: DATA_DIR });
    }
  });
});

// ---------------------------------------------------------------------------
// gitPush
// ---------------------------------------------------------------------------

describe("gitPush", () => {
  it("returns success when add, commit, and push all succeed", () => {
    mockSpawnSequence([{ status: 0 }, { status: 0 }, { status: 0 }]);
    const result = gitPush(DATA_DIR, "ingest: 2026-04-16");
    expect(result.success).toBe(true);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(3);
  });

  it("tolerates empty commit (exit 1) and still pushes without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // add ok, commit empty (exit 1), push ok
    mockSpawnSequence([{ status: 0 }, { status: 1, stderr: "nothing to commit" }, { status: 0 }]);

    const result = gitPush(DATA_DIR, "ingest: 2026-04-16");

    expect(result.success).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    // push was still called (3rd spawnSync call)
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it("warns and returns failure when push fails", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSpawnSequence([{ status: 0 }, { status: 0 }, { status: 1, stderr: "push rejected" }]);

    const result = gitPush(DATA_DIR, "ingest: 2026-04-16");

    expect(result.success).toBe(false);
    expect(result.message).toContain("git push failed");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("git push failed"));
    warnSpy.mockRestore();
  });

  it("does not throw when push fails", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSpawnSequence([{ status: 0 }, { status: 0 }, { status: 1, stderr: "error" }]);
    expect(() => gitPush(DATA_DIR, "test")).not.toThrow();
  });

  it("passes the data dir as cwd for all git calls", () => {
    mockSpawnSequence([{ status: 0 }, { status: 0 }, { status: 0 }]);
    gitPush(DATA_DIR, "test");
    for (const call of vi.mocked(spawnSync).mock.calls) {
      expect(call[2]).toMatchObject({ cwd: DATA_DIR });
    }
  });
});
