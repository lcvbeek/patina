import { describe, it, expect } from "vitest";
import {
  estimateTokensFromChars,
  estimateTextTokens,
  exceedsPatinaCoreTokenTarget,
  PATINA_CORE_TOKEN_TARGET,
} from "./token-estimate.js";

describe("estimateTokensFromChars", () => {
  it("matches the chars/4.5 heuristic with ceil rounding", () => {
    expect(estimateTokensFromChars(45)).toBe(10);
    expect(estimateTokensFromChars(46)).toBe(11);
  });
});

describe("estimateTextTokens", () => {
  it("returns line count, char count, and estimated tokens", () => {
    const estimate = estimateTextTokens("alpha\nbeta");
    expect(estimate.lines).toBe(2);
    expect(estimate.chars).toBe(10);
    expect(estimate.estimatedTokens).toBe(3);
  });
});

describe("exceedsPatinaCoreTokenTarget", () => {
  it("returns true only when estimate is above the 500 token target", () => {
    expect(
      exceedsPatinaCoreTokenTarget({
        lines: 1,
        chars: 2250,
        estimatedTokens: PATINA_CORE_TOKEN_TARGET,
      }),
    ).toBe(false);

    expect(
      exceedsPatinaCoreTokenTarget({
        lines: 1,
        chars: 2251,
        estimatedTokens: PATINA_CORE_TOKEN_TARGET + 1,
      }),
    ).toBe(true);
  });
});
