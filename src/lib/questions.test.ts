import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { loadQuestions, PUBLIC_QUESTIONS } from "./questions.js";

describe("loadQuestions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patina-questions-test-"));
    fs.mkdirSync(path.join(tmpDir, ".patina"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns PUBLIC_QUESTIONS when no questions.json exists", () => {
    expect(loadQuestions(tmpDir)).toBe(PUBLIC_QUESTIONS);
  });

  it("returns custom questions when file is valid", () => {
    const custom = [
      { key: "q1", text: "How did it go?" },
      { key: "q2", text: "What went wrong?" },
    ];
    fs.writeFileSync(
      path.join(tmpDir, ".patina", "questions.json"),
      JSON.stringify(custom),
      "utf-8",
    );
    expect(loadQuestions(tmpDir)).toEqual(custom);
  });

  it("falls back to defaults when file is empty array", () => {
    fs.writeFileSync(path.join(tmpDir, ".patina", "questions.json"), "[]", "utf-8");
    expect(loadQuestions(tmpDir)).toBe(PUBLIC_QUESTIONS);
  });

  it("falls back to defaults when an item is missing the key field", () => {
    const invalid = [{ text: "What happened?" }];
    fs.writeFileSync(
      path.join(tmpDir, ".patina", "questions.json"),
      JSON.stringify(invalid),
      "utf-8",
    );
    expect(loadQuestions(tmpDir)).toBe(PUBLIC_QUESTIONS);
  });

  it("falls back to defaults when an item is missing the text field", () => {
    const invalid = [{ key: "q1" }];
    fs.writeFileSync(
      path.join(tmpDir, ".patina", "questions.json"),
      JSON.stringify(invalid),
      "utf-8",
    );
    expect(loadQuestions(tmpDir)).toBe(PUBLIC_QUESTIONS);
  });

  it("falls back to defaults when an item has numeric key field", () => {
    const invalid = [{ key: 42, text: "Some question" }];
    fs.writeFileSync(
      path.join(tmpDir, ".patina", "questions.json"),
      JSON.stringify(invalid),
      "utf-8",
    );
    expect(loadQuestions(tmpDir)).toBe(PUBLIC_QUESTIONS);
  });

  it("falls back to defaults when file contains null item", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".patina", "questions.json"),
      JSON.stringify([null]),
      "utf-8",
    );
    expect(loadQuestions(tmpDir)).toBe(PUBLIC_QUESTIONS);
  });

  it("falls back to defaults when file is not an array (object)", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".patina", "questions.json"),
      JSON.stringify({ key: "q1", text: "hi" }),
      "utf-8",
    );
    expect(loadQuestions(tmpDir)).toBe(PUBLIC_QUESTIONS);
  });

  it("falls back to defaults when JSON is malformed", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".patina", "questions.json"),
      "{ this is not json",
      "utf-8",
    );
    expect(loadQuestions(tmpDir)).toBe(PUBLIC_QUESTIONS);
  });
});
