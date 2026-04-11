import fs from "fs";
import path from "path";
import { PATINA_DIR } from "./storage.js";

// ---------------------------------------------------------------------------
// Reflection questions — shared between patina reflect and patina run
// ---------------------------------------------------------------------------

export const PUBLIC_QUESTIONS: Array<{ key: string; text: string }> = [
  {
    key: "overall_feel",
    text: "How did this cycle feel overall? (work pace, AI collaboration, output quality)",
  },
  {
    key: "went_well",
    text: "What AI-assisted work went particularly well?",
  },
  {
    key: "inefficiencies",
    text: "What felt inefficient, frustrating, or produced poor results?",
  },
  {
    key: "near_misses",
    text: "Any near-misses — moments where AI almost did something wrong or risky?",
  },
  {
    key: "do_differently",
    text: "Anything specific you want your AI to do differently next cycle?",
  },
  {
    key: "other",
    text: "Anything else worth capturing? (optional — press Enter to skip)",
  },
];

/**
 * Load reflection questions for the given project.
 * If .patina/questions.json exists and is valid, it overrides the defaults.
 * This allows teams to customise the questions asked during patina reflect.
 */
export function loadQuestions(cwd = process.cwd()): Array<{ key: string; text: string }> {
  const file = path.join(cwd, PATINA_DIR, "questions.json");
  if (!fs.existsSync(file)) return PUBLIC_QUESTIONS;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (
      Array.isArray(raw) &&
      raw.length > 0 &&
      raw.every(
        (q) =>
          typeof q === "object" &&
          q !== null &&
          typeof (q as Record<string, unknown>).key === "string" &&
          typeof (q as Record<string, unknown>).text === "string",
      )
    ) {
      return raw as Array<{ key: string; text: string }>;
    }
  } catch {
    // fall through to defaults
  }
  return PUBLIC_QUESTIONS;
}
