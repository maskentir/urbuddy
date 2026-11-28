export interface TranslationPreflightInput {
  readonly enabled: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly model: string;
  readonly supportedModels: readonly string[];
  readonly maxRequests: number;
  readonly maxOutputTokens: number;
  readonly maxContextUtterances: number;
  readonly maxInputTokensPerRequest: number;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly loopback: boolean;
}

export interface TranslationPreflightCheck {
  readonly id: string;
  readonly status: "pass" | "fail" | "unverified";
  readonly detail: string;
}

export interface TranslationPreflightResult {
  readonly checks: readonly TranslationPreflightCheck[];
  readonly estimatedCostUsd: number;
  readonly blocked: boolean;
}

/** [tooling] The published Standard rates per million tokens, from the model selection evidence. */
export const TRANSLATION_RATES_PER_MILLION_TOKENS: Readonly<
  Record<string, { readonly input: number; readonly output: number }>
> = {
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-6.1-terra": { input: 1.0, output: 5.0 },
};

export function translationPreflight(input: TranslationPreflightInput): TranslationPreflightResult {
  const checks: TranslationPreflightCheck[] = [];
  const add = (id: string, status: TranslationPreflightCheck["status"], detail: string): void => {
    checks.push({ id, status, detail });
  };

  if (!input.enabled) {
    add("translation", "pass", "translation is not enabled for this run");
    return { checks, estimatedCostUsd: 0, blocked: false };
  }

  add(
    "model-selection",
    input.supportedModels.includes(input.model) ? "pass" : "fail",
    `model=${input.model} (supported: ${input.supportedModels.join(", ")})`,
  );
  const credential = input.env["URBUDDY_OPENAI_API_KEY"];
  add(
    "credential-availability",
    credential !== undefined && credential.trim().length > 0
      ? "pass"
      : input.loopback
        ? "pass"
        : "fail",
    credential !== undefined && credential.trim().length > 0
      ? "URBUDDY_OPENAI_API_KEY is available (value not displayed)"
      : input.loopback
        ? "loopback server: the adapter uses its own test credential"
        : "URBUDDY_OPENAI_API_KEY is not configured",
  );
  const endpoint = input.env["URBUDDY_TRANSLATE_ENDPOINT"];
  add(
    "endpoint",
    input.loopback ? "pass" : endpoint === undefined ? "pass" : "fail",
    input.loopback
      ? `loopback endpoint ${endpoint ?? "local"} (no egress)`
      : endpoint === undefined
        ? "endpoint=https://api.openai.com/v1"
        : `endpoint override ${endpoint} requires explicit authorization`,
  );
  add(
    "languages",
    input.sourceLanguage.length > 0 && input.targetLanguage.length > 0 ? "pass" : "fail",
    `${input.sourceLanguage} to ${input.targetLanguage}`,
  );
  add(
    "local-ceilings",
    input.maxRequests > 0 && input.maxOutputTokens > 0 ? "pass" : "fail",
    `at most ${input.maxRequests} requests, ${input.maxOutputTokens} output tokens each, ` +
      `${input.maxContextUtterances} context utterances, ${input.maxInputTokensPerRequest} input tokens each`,
  );
  const rate = TRANSLATION_RATES_PER_MILLION_TOKENS[input.model];
  const inputTokens = input.maxRequests * input.maxInputTokensPerRequest;
  const outputTokens = input.maxRequests * input.maxOutputTokens;
  const estimatedCostUsd =
    rate === undefined ? 0 : (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
  add(
    "estimated-cost",
    rate === undefined ? "fail" : "pass",
    rate === undefined
      ? `no published rate for ${input.model}`
      : `ceiling ${inputTokens} input and ${outputTokens} output tokens at ` +
          `USD ${rate.input}/${rate.output} per million = USD ${estimatedCostUsd.toFixed(6)}`,
  );
  add(
    "retention",
    "unverified",
    "the provider retention terms for transcript text are not contractually verified here",
  );
  add(
    "provenance",
    "pass",
    "captured synthetic transcript events only, no private meeting content",
  );
  const blocked = checks.some((check) => check.status === "fail");
  return { checks, estimatedCostUsd, blocked };
}

export function formatTranslationPreflight(result: TranslationPreflightResult): string {
  return result.checks
    .map((check) => {
      const mark =
        check.status === "pass" ? "ok" : check.status === "fail" ? "BLOCKED" : "unverified";
      return `  [${mark.padEnd(10)}] ${check.id}: ${check.detail}`;
    })
    .join("\n");
}
