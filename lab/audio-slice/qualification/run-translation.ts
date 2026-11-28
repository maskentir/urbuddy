import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createTranslationProviderFromEnv } from "../../../src/adapters/translation/openai.js";
import { loadOperationEnvironment } from "../../../src/modules/config/environment.js";
import {
  DEFAULT_TRANSLATION_MODEL,
  loadTranslationConfig,
} from "../../../src/modules/config/translation.js";
import type { TranscriptEvent } from "../../../src/modules/perception/speech.js";
import { ComprehensionEngine } from "../comprehension.js";
import { RuntimeFeed } from "../feed.js";

import {
  createBudgetedProvider,
  estimateCostUsd,
  parseBoundedInteger,
  traceChecksumMatches,
  TRANSLATION_RATES_PER_MILLION_TOKENS,
  type BudgetRefusal,
} from "./translation-budget.js";

const HELP = `urbuddy translation-only qualification (no Muse, no audio)

  tsx lab/audio-slice/qualification/run-translation.ts --help

Consumes captured canonical transcript events, reuses the production
translation scheduler and adapter, and never constructs a speech provider
and never transmits audio.`;

const here = fileURLToPath(new URL(".", import.meta.url));
const EVALUATION_DIR = join(here, "..", "..", "..", "evaluation", "language", "comprehension-v1");

const MAX_REQUESTS_CEILING = 16;
const MAX_INPUT_BYTES_CEILING = 16_000;
const MAX_OUTPUT_TOKENS = 1_024;
const FRAMING_ALLOWANCE_TOKENS = 256;
const TOKEN_BUDGET_RATIO = 4;

interface CapturedEvent {
  readonly utteranceId: string;
  readonly revision: number;
  readonly text: string;
  readonly kind: "partial" | "final" | "discontinuity";
  readonly reason?: string;
  readonly detail?: string;
}

interface EvaluationCase {
  readonly id: string;
  readonly source: string;
  readonly reference: string;
}

const { values } = parseArgs({
  options: {
    help: { type: "boolean" },
    "env-file": { type: "string" },
    trace: { type: "string" },
    model: { type: "string" },
    "max-requests": { type: "string" },
    "max-input-bytes": { type: "string" },
    "owner-authorized": { type: "boolean" },
    authorization: { type: "string" },
    "trace-sha256": { type: "string" },
    "authorization-scope": { type: "string" },
  },
});

if (values.help === true) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

function fail(message: string): never {
  process.stdout.write(`${message}\nNo provider request was issued.\n`);
  process.exit(2);
}

const requestsLimit = parseBoundedInteger(
  values["max-requests"],
  MAX_REQUESTS_CEILING,
  MAX_REQUESTS_CEILING,
  "max-requests",
);
if (!requestsLimit.accepted) fail(requestsLimit.detail);
const maxRequests = Number(values["max-requests"] ?? MAX_REQUESTS_CEILING);
const bytesLimit = parseBoundedInteger(
  values["max-input-bytes"],
  MAX_INPUT_BYTES_CEILING,
  MAX_INPUT_BYTES_CEILING,
  "max-input-bytes",
);
if (!bytesLimit.accepted) fail(bytesLimit.detail);
const maxInputBytes = Number(values["max-input-bytes"] ?? MAX_INPUT_BYTES_CEILING);
const model = values.model ?? DEFAULT_TRANSLATION_MODEL;
const tracePath = values.trace;
if (tracePath === undefined) {
  fail("a captured canonical transcript trace is required.");
}

const traceBytes = readFileSync(tracePath);
const traceSha256 = createHash("sha256").update(traceBytes).digest("hex");
const checksum = traceChecksumMatches(values["trace-sha256"], traceSha256);
if (!checksum.accepted) fail(checksum.detail);

const captured = traceBytes
  .toString("utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as { kind: string; data?: Record<string, unknown> })
  .filter((row) => row.kind === "final-committed" || row.kind === "canonical-discontinuity")
  .map((row): CapturedEvent => {
    if (row.kind === "canonical-discontinuity") {
      return {
        utteranceId: String(row.data?.["utteranceId"] ?? ""),
        revision: Number(row.data?.["revision"] ?? 0),
        text: "",
        kind: "discontinuity",
        reason: String(row.data?.["reason"] ?? "capture-gap"),
        detail: String(row.data?.["detail"] ?? ""),
      };
    }
    return {
      utteranceId: String(row.data?.["utteranceId"] ?? ""),
      revision: Number(row.data?.["revision"] ?? 0),
      text: String(row.data?.["text"] ?? ""),
      kind: "final",
    };
  }) as CapturedEvent[];

if (captured.length === 0) {
  fail("the captured trace carries no canonical transcript events.");
}

const worstCaseInputTokens =
  maxRequests * Math.ceil(maxInputBytes / TOKEN_BUDGET_RATIO + FRAMING_ALLOWANCE_TOKENS);
const worstCaseOutputTokens = maxRequests * MAX_OUTPUT_TOKENS;
const worstCaseCostUsd = estimateCostUsd(model, worstCaseInputTokens, worstCaseOutputTokens) ?? 0;
const rate = TRANSLATION_RATES_PER_MILLION_TOKENS[model];
if (rate === undefined) {
  fail(`no published rate is known for model ${model}.`);
}

const requiredScope = [
  `model=${model}`,
  `trace=${traceSha256}`,
  `maxRequests=${maxRequests}`,
  `maxInputBytes=${maxInputBytes}`,
  `maxOutputTokens=${MAX_OUTPUT_TOKENS}`,
  `maxCostUsd=${worstCaseCostUsd.toFixed(6)}`,
].join(";");

process.stdout.write(
  `translation qualification preflight\n` +
    `  model=${model} provider=openai endpoint=from environment\n` +
    `  trace=${tracePath}\n` +
    `  trace sha256=${traceSha256}\n` +
    `  captured canonical events=${captured.length}\n` +
    `  limits: ${maxRequests} requests, ${maxInputBytes} serialized input bytes per request, ` +
    `${MAX_OUTPUT_TOKENS} output tokens per request\n` +
    `  conservative cost ceiling: ${worstCaseInputTokens} input and ${worstCaseOutputTokens} output ` +
    `tokens = USD ${worstCaseCostUsd.toFixed(6)} at USD ${rate.input}/${rate.output} per million\n` +
    `  required authorization scope: ${requiredScope}\n`,
);

if (values["owner-authorized"] !== true || values.authorization === undefined) {
  fail(
    "a translation specific owner authorization, an authorization reference, and the exact " +
      "authorization scope are required. The Muse authorization is not reused.",
  );
}
if (values["authorization-scope"] !== requiredScope) {
  fail(
    `the authorization scope does not match the computed scope.\n  expected: ${requiredScope}\n` +
      `  received: ${values["authorization-scope"] ?? "none"}`,
  );
}

const environment = loadOperationEnvironment(process.env, values["env-file"]);
if (environment.isErr()) {
  fail(`the environment could not be loaded: ${environment.error.message}`);
}
const env = environment.value;
const translationConfig = loadTranslationConfig(true, {}, env);
if (translationConfig.isErr() || !translationConfig.value.enabled) {
  fail("the translation configuration is not valid.");
}
const provider = createTranslationProviderFromEnv(env, model);
if (provider.isErr()) {
  fail(`the translation provider is not configured: ${provider.error.message}`);
}

const refusals: BudgetRefusal[] = [];
const budgeted = createBudgetedProvider(
  provider.value,
  {
    maxRequests,
    maxInputBytesPerRequest: maxInputBytes,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    modelId: model,
  },
  (refusal) => refusals.push(refusal),
);

const holder: { engine?: ComprehensionEngine } = {};
const feed = new RuntimeFeed({
  sessionId: "translation-qualification",
  streamId: "main",
  provider: [],
  authoredTranscripts: [],
  translations: [],
  intelligence: [],
  gapSkips: [],
  onOutput: (output) => {
    holder.engine?.accept(output);
  },
});
feed.start();
const controller = new AbortController();
const engine = new ComprehensionEngine({
  provider: budgeted,
  languages: {
    sourceLanguage: translationConfig.value.sourceLanguage,
    targetLanguage: translationConfig.value.targetLanguage,
  },
  signal: controller.signal,
  domain: feed.domain,
  enableProvisionals: false,
});
holder.engine = engine;

for (const event of captured) {
  const canonical: TranscriptEvent =
    event.kind === "discontinuity"
      ? {
          type: "discontinuity",
          reason: event.reason === "reconnect" ? "reconnect" : "capture-gap",
          detail: event.detail ?? "",
        }
      : {
          type: "final",
          utteranceId: event.utteranceId,
          revision: event.revision,
          text: event.text,
        };
  engine.ingest(canonical);
  if (event.kind !== "discontinuity") {
    feed.ingestCanonicalEvent(canonical, 0);
    await feed.idle();
  }
}

const summary = await engine.finish();

const cases = (
  JSON.parse(readFileSync(join(EVALUATION_DIR, "development.json"), "utf8")) as {
    cases: EvaluationCase[];
  }
).cases;

const lines: string[] = [];
lines.push("translation-only qualification");
lines.push(`authorization: ${values.authorization}`);
lines.push(`scope: ${requiredScope}`);
lines.push(
  `requests=${summary.requests} responses=${summary.responses} committed=${summary.committed} ` +
    `provisionals=${summary.provisionals} failed=${summary.failedInvocations} ` +
    `cancelled=${summary.cancelledInvocations} staleRejected=${summary.staleRejected} ` +
    `degraded=${summary.degraded} uncovered=${summary.uncovered} ` +
    `inputTokens=${summary.inputTokens ?? "unknown"} outputTokens=${summary.outputTokens ?? "unknown"} ` +
    `estimatedCostUsd=${(estimateCostUsd(model, summary.inputTokens ?? 0, summary.outputTokens ?? 0) ?? 0).toFixed(6)}`,
);
if (refusals.length > 0) {
  lines.push(`budget refusals: ${refusals.map((refusal) => refusal.reason).join("; ")}`);
}
lines.push("");
lines.push("committed translations:");
for (const row of feed.domain.utterances) {
  const evaluationCase = cases.find((entry) => entry.source === row.text);
  lines.push(`  ${evaluationCase?.id ?? row.key}`);
  lines.push(`    source: ${row.text}`);
  lines.push(`    translation: ${row.translation?.text ?? "none"}`);
  lines.push(`    state: ${row.translation?.state ?? "none"}`);
}
process.stdout.write(`${lines.join("\n")}\n`);
