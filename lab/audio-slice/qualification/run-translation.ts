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

interface CapturedEvent {
  readonly utteranceId: string;
  readonly revision: number;
  readonly text: string;
}

interface EvaluationCase {
  readonly id: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly source: string;
  readonly context: readonly string[];
  readonly reference: string;
  readonly intendedMeaning: string;
  readonly incorrectInterpretation: string;
}

const { values } = parseArgs({
  options: {
    help: { type: "boolean" },
    "env-file": { type: "string" },
    trace: { type: "string" },
    model: { type: "string" },
    "max-requests": { type: "string" },
    "max-input-bytes": { type: "string" },
    output: { type: "string" },
  },
});

if (values.help === true) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const environment = loadOperationEnvironment(process.env, values["env-file"]);
if (environment.isErr()) {
  throw new Error(`environment could not be loaded: ${environment.error.message}`);
}
const env = environment.value;
const model = values.model ?? DEFAULT_TRANSLATION_MODEL;
const maxRequests = values["max-requests"] === undefined ? 16 : Number(values["max-requests"]);
const maxInputBytes =
  values["max-input-bytes"] === undefined ? 16_000 : Number(values["max-input-bytes"]);

const development = JSON.parse(readFileSync(join(EVALUATION_DIR, "development.json"), "utf8")) as {
  cases: EvaluationCase[];
};
const heldout = JSON.parse(readFileSync(join(EVALUATION_DIR, "heldout.json"), "utf8")) as {
  cases: EvaluationCase[];
};
const cases = [...development.cases, ...heldout.cases];

const tracePath = values.trace;
if (tracePath === undefined) {
  throw new Error("a captured canonical transcript trace is required");
}
const captured = readFileSync(tracePath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as { kind: string; data?: Record<string, unknown> })
  .filter((row) => row.kind === "final-committed")
  .map((row) => ({
    utteranceId: String(row.data?.["utteranceId"] ?? ""),
    revision: Number(row.data?.["revision"] ?? 0),
    text: String(row.data?.["text"] ?? ""),
  })) as CapturedEvent[];

if (captured.length === 0) {
  throw new Error("the captured trace carries no canonical final transcript events");
}

const translationConfig = loadTranslationConfig(true, {}, env);
if (translationConfig.isErr()) {
  throw new Error(`translation configuration failed: ${translationConfig.error.message}`);
}
if (!translationConfig.value.enabled) {
  throw new Error("translation configuration is not enabled");
}
const provider = createTranslationProviderFromEnv(env, model);
if (provider.isErr()) {
  throw new Error(`translation provider failed: ${provider.error.message}`);
}

const refusals: BudgetRefusal[] = [];
const budgeted = createBudgetedProvider(
  provider.value,
  { maxRequests, maxInputBytesPerRequest: maxInputBytes, maxOutputTokens: 1_024, modelId: model },
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

const results: { id: string; source: string; translation: string | undefined }[] = [];
for (const [index, event] of captured.entries()) {
  const canonical: TranscriptEvent = {
    type: "final",
    utteranceId: event.utteranceId,
    revision: event.revision,
    text: event.text,
  };
  feed.ingestCanonicalEvent(canonical, index);
  engine.ingest(canonical);
  await feed.idle();
}

const summary = await engine.finish();

const byText = new Map<string, string | undefined>();
for (const row of feed.domain.utterances) {
  byText.set(row.text, row.translation?.text);
}
for (const [index, event] of captured.entries()) {
  const evaluationCase = cases.find((entry) => entry.source === event.text);
  results.push({
    id: evaluationCase?.id ?? `captured-${index + 1}`,
    source: event.text,
    translation: byText.get(event.text),
  });
}

const inputTokens = summary.inputTokens ?? 0;
const outputTokens = summary.outputTokens ?? 0;
const rate = TRANSLATION_RATES_PER_MILLION_TOKENS[model];
const lines: string[] = [];
lines.push("translation-only qualification");
lines.push(`model=${model} provider=${provider.value.providerId} endpoint=from environment`);
lines.push(
  `captured canonical final events=${captured.length} evaluation cases=${cases.length} ` +
    `development=${development.cases.length} heldout=${heldout.cases.length}`,
);
lines.push(
  `requests=${summary.requests} responses=${summary.responses} committed=${summary.committed} ` +
    `provisionals=${summary.provisionals} failed=${summary.failedInvocations} ` +
    `cancelled=${summary.cancelledInvocations} staleRejected=${summary.staleRejected} ` +
    `degraded=${summary.degraded} uncovered=${summary.uncovered}`,
);
lines.push(
  `budget: max requests ${maxRequests}, max serialized input ${maxInputBytes} bytes, ` +
    `max output tokens 1024, refusals ${refusals.length}` +
    (refusals.length === 0 ? "" : ` (${refusals.map((refusal) => refusal.reason).join("; ")})`),
);
lines.push(
  `usage: ${inputTokens} input tokens, ${outputTokens} output tokens, estimated cost ` +
    `USD ${(estimateCostUsd(model, inputTokens, outputTokens) ?? 0).toFixed(6)} ` +
    `(rate ${rate?.input ?? "unknown"}/${rate?.output ?? "unknown"} per million)`,
);
lines.push("");
lines.push("translations:");
for (const result of results) {
  lines.push(`  ${result.id}`);
  lines.push(`    source: ${result.source}`);
  lines.push(`    output: ${result.translation ?? "no translation"}`);
}
process.stdout.write(`${lines.join("\n")}\n`);
