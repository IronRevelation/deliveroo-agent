export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Detects negative-reward actions while allowing useful avoidance rules. */
export function hasExplicitNegativeUtility(mission: string): boolean {
  const text = mission.toLowerCase();
  if (/\b(?:do not|don't|never|avoid)\b/.test(text) || /\botherwise\b[^.]*\b(?:lose|cost|penalt)/.test(text)) {
    return false;
  }
  return (
    /\b(?:get|earn|receive|reward(?:ed)?(?:\s+with)?|for)\s+(?:a\s+)?-\s*\d+(?:\.\d+)?\s*(?:points?|pts?)?\b/.test(text) ||
    /\b(?:costs?|lose|loses|pay|pays)\s+(?:you\s+)?\d+(?:\.\d+)?\s*(?:points?|pts?)?\b/.test(text) ||
    /\bpenalt(?:y|ized)\s+(?:of|by|with)?\s*\d+(?:\.\d+)?\s*(?:points?|pts?)?\b/.test(text)
  );
}

/** Evaluates LLM-selected arithmetic after restricting it to a small numeric language. */
export function evaluateArithmetic(expression: string): number {
  if (!/^[0-9+\-*/ ().]+$/.test(expression)) throw new Error(`Unsafe expression: ${expression}`);
  const result = Function(`"use strict"; return (${expression});`)();
  if (!Number.isFinite(result)) throw new Error(`Invalid arithmetic result for: ${expression}`);
  return Number(result);
}
