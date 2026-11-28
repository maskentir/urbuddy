import { boundTranslationProvider } from "../../../src/modules/language/budget.js";
import type { TranslationProvider } from "../../../src/modules/language/translation.js";

export interface TranslationBudget {
  readonly maxRequests: number;
  readonly maxInputBytesPerRequest: number;
  readonly maxOutputTokens: number;
  readonly modelId: string;
}

export interface BudgetRefusal {
  readonly reason: string;
  readonly requests: number;
}

/** [tooling] The published Standard rates per million tokens. */
export const TRANSLATION_RATES_PER_MILLION_TOKENS: Readonly<
  Record<string, { readonly input: number; readonly output: number }>
> = {
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-6.1-terra": { input: 1.0, output: 5.0 },
};

export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const rate = TRANSLATION_RATES_PER_MILLION_TOKENS[modelId];
  if (rate === undefined) return undefined;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

/**
 * [security] A budgeted provider refuses an over-limit request before it
 * reaches the network, so an exhausted budget cannot produce an outbound
 * request.
 */
export function createBudgetedProvider(
  provider: TranslationProvider,
  budget: TranslationBudget,
  onRefusal: (refusal: BudgetRefusal) => void,
): TranslationProvider {
  return boundTranslationProvider(provider, budget, (reason, requests) =>
    onRefusal({ reason, requests }),
  );
}

export interface LimitCheck {
  readonly accepted: boolean;
  readonly detail: string;
}

export function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  ceiling: number,
  name: string,
): LimitCheck {
  if (raw === undefined) {
    return { accepted: true, detail: `${name} defaults to ${fallback}` };
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      accepted: false,
      detail: `${name} must be a positive integer, received "${raw}"`,
    };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ceiling) {
    return {
      accepted: false,
      detail: `${name} must be an integer between 1 and ${ceiling}, received "${raw}"`,
    };
  }
  return { accepted: true, detail: `${name} is ${parsed}` };
}

export function traceChecksumMatches(expected: string | undefined, actual: string): LimitCheck {
  if (expected === undefined) {
    return { accepted: false, detail: "the trace checksum must be stated explicitly" };
  }
  return expected === actual
    ? { accepted: true, detail: `trace checksum ${actual} matches` }
    : {
        accepted: false,
        detail: `trace checksum mismatch, expected ${actual}, received ${expected}`,
      };
}

export function budgetRefusalResult(refusals: readonly BudgetRefusal[]): {
  readonly refused: boolean;
  readonly detail: string;
} {
  if (refusals.length === 0) {
    return { refused: false, detail: "no refusal" };
  }
  return {
    refused: true,
    detail: refusals.map((refusal) => refusal.reason).join("; "),
  };
}
