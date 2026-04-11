/**
 * Lightweight markdown lint checks for patina-generated content.
 * Catches the most common issues without requiring markdownlint as a
 * runtime dependency. For full linting, run `npm run lint:md`.
 */

export interface LintWarning {
  line: number;
  rule: string;
  message: string;
}

/**
 * Run basic markdown lint checks on content.
 * Returns an array of warnings (empty = clean).
 */
export function lintMarkdown(content: string): readonly LintWarning[] {
  const lines = content.split("\n");
  const warnings: LintWarning[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : "";

    // MD032: Lists should be surrounded by blank lines
    if (line.match(/^[-*+] /) && prev.trim() !== "" && !prev.match(/^[-*+] /)) {
      warnings.push({
        line: i + 1,
        rule: "MD032",
        message: "List item should be preceded by a blank line",
      });
    }

    // Trailing whitespace
    if (line.match(/[ \t]+$/) && line.trim() !== "") {
      warnings.push({
        line: i + 1,
        rule: "MD009",
        message: "Trailing whitespace",
      });
    }

    // Multiple consecutive blank lines
    if (line.trim() === "" && prev.trim() === "" && i > 1 && lines[i - 2].trim() === "") {
      warnings.push({
        line: i + 1,
        rule: "MD012",
        message: "Multiple consecutive blank lines",
      });
    }
  }

  return warnings;
}

/**
 * Auto-fix common markdown lint issues in content.
 * Returns the fixed content string.
 */
export function fixMarkdown(content: string): string {
  let result = content;

  // Ensure blank line before list items that follow non-list content
  result = result.replace(/([^\n])\n([-*+] )/g, "$1\n\n$2");

  // Remove trailing whitespace
  result = result.replace(/[ \t]+$/gm, "");

  // Collapse 3+ consecutive blank lines to 2
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
