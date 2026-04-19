export const ESTIMATED_CHARS_PER_TOKEN = 4.5;
export const PATINA_CORE_TOKEN_TARGET = 500;

export interface TextTokenEstimate {
  lines: number;
  chars: number;
  estimatedTokens: number;
}

export function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / ESTIMATED_CHARS_PER_TOKEN);
}

export function estimateTextTokens(content: string): TextTokenEstimate {
  const chars = content.length;
  return {
    lines: content.split("\n").length,
    chars,
    estimatedTokens: estimateTokensFromChars(chars),
  };
}

export function exceedsPatinaCoreTokenTarget(estimate: TextTokenEstimate): boolean {
  return estimate.estimatedTokens > PATINA_CORE_TOKEN_TARGET;
}
