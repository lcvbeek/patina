import { spawnSync } from "child_process";

export function getGitAuthor(): string {
  const result = spawnSync("git", ["config", "user.name"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return process.env.USER ?? "unknown";
}
