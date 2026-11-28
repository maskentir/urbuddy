import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { render, renderToString } from "ink";
import React from "react";

import { openWavSource } from "../../../src/adapters/audio/wav-source.js";
import { createMuseProviderFromEnv } from "../../../src/adapters/speech/muse.js";
import {
  createTranslationProviderFromEnv,
  SUPPORTED_TRANSLATION_MODELS,
} from "../../../src/adapters/translation/openai.js";
import { loadOperationEnvironment } from "../../../src/modules/config/environment.js";
import {
  DEFAULT_TRANSLATION_MODEL,
  loadTranslationConfig,
} from "../../../src/modules/config/translation.js";
import type { CaptureSource, SourceItem } from "../../../src/modules/perception/audio.js";
import { runTranscription, type TranscriptEvent } from "../../../src/modules/perception/speech.js";
import { ComprehensionEngine } from "../comprehension.js";
import { RuntimeFeed } from "../feed.js";
import { AdaptiveApp, AdaptiveScreen, type AppController } from "../screen.js";
import { actUser, initialSession, touchLiveView, type Session } from "../session.js";

import {
  instrumentProvider,
  MUSE_PRICE_PER_HOUR_USD,
  type ProviderObservation,
} from "./instrumented-provider.js";
import {
  QUALIFICATION_LEDGER_LIMITS,
  cumulativeUsage,
  fileSha256,
  ledgerDecision,
  readLedger,
  writeLedger,
  type AttemptRecord,
} from "./ledger.js";
import { qualificationTimeouts, timeoutDecision } from "./limits.js";
import { FIXTURE_PROVENANCE, formatPreflight, runPreflight } from "./preflight.js";
import { createRenderObserver } from "./render-observer.js";
import { decideRender } from "./render-policy.js";
import { formatTranslationPreflight, translationPreflight } from "./translation-preflight.js";

const HELP = `urbuddy Muse STT qualification (real provider, paid, owner authorized)

  tsx lab/audio-slice/qualification/run-muse.tsx --help

The transmitted audio ceiling, the connection allowance, the finalization
drain allowance, and the overall watchdog are separate limits. The run
issues no provider request unless the preflight passes, including the
explicit owner authorization.`;

const here = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_MANIFEST = join(here, "audio", "manifest.json");
const DEFAULT_VOCABULARY = join(here, "vocabulary.json");
const TRACE_DIR = join(here, "trace");
const LEDGER_PATH = join(here, "state", "attempts.json");

interface TraceRow {
  readonly kind: string;
  readonly monoMs: number;
  readonly elapsedMs: number;
  readonly detail: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

const { values } = parseArgs({
  options: {
    help: { type: "boolean" },
    "env-file": { type: "string" },
    fixture: { type: "string" },
    model: { type: "string" },
    mode: { type: "string" },
    "owner-authorized": { type: "boolean" },
    authorization: { type: "string" },
    "max-seconds": { type: "string" },
    "max-attempts": { type: "string" },
    "watchdog-connection-seconds": { type: "string" },
    "watchdog-finalization-seconds": { type: "string" },
    keywords: { type: "string" },
    vocabulary: { type: "string" },
    headless: { type: "boolean" },
    "render-progress": { type: "boolean" },
    translate: { type: "boolean" },
    "translation-model": { type: "string" },
    loopback: { type: "string" },
    output: { type: "string" },
  },
});

if (values.help === true) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const maxAudioSeconds = values["max-seconds"] === undefined ? 30 : Number(values["max-seconds"]);
const maxAttempts = values["max-attempts"] === undefined ? 3 : Number(values["max-attempts"]);
const connectionSeconds =
  values["watchdog-connection-seconds"] === undefined
    ? 15
    : Number(values["watchdog-connection-seconds"]);
const drainSeconds =
  values["watchdog-finalization-seconds"] === undefined
    ? 15
    : Number(values["watchdog-finalization-seconds"]);
const model = values.model ?? "muse-voice-transcribe-1.0";
const mode = values.mode ?? "endpointing";
const ownerAuthorized = values["owner-authorized"] === true;
const renderProgress = values["render-progress"] === true;
const loopbackEndpoint = values.loopback;

const vocabularyFile = values.vocabulary ?? DEFAULT_VOCABULARY;
const vocabulary = JSON.parse(readFileSync(vocabularyFile, "utf8")) as {
  vocabularyId: string;
  terms: string[];
};
const keywords =
  values.keywords === undefined
    ? vocabulary.terms
    : values.keywords
        .split(",")
        .map((term) => term.trim())
        .filter((term) => term.length > 0);

const environment = loadOperationEnvironment(process.env, values["env-file"]);
if (environment.isErr()) {
  throw new Error(`environment could not be loaded: ${environment.error.message}`);
}
const env = environment.value;

const fixturePath = values.fixture ?? join(here, "audio", "qualification.wav");
const fixtureSha256 = fileSha256(fixturePath);
const ledger = readLedger(LEDGER_PATH);
const usage = cumulativeUsage(ledger);
const nextAttemptCostUsd = (maxAudioSeconds * MUSE_PRICE_PER_HOUR_USD) / 3600;
const budget = ledgerDecision(
  ledger,
  QUALIFICATION_LEDGER_LIMITS,
  maxAudioSeconds,
  nextAttemptCostUsd,
);
process.stdout.write(
  `ledger: ${usage.attempts} recorded attempts, ${usage.seconds.toFixed(2)}s and ` +
    `USD ${usage.costUsd.toFixed(6)} consumed; ${budget.detail}\n`,
);

const manifest = JSON.parse(readFileSync(DEFAULT_MANIFEST, "utf8")) as {
  audioMs: number;
  sampleRate: number;
  spans: Record<string, { startMs: number; durationMs: number }>;
};

const translateEnabled = values.translate === true;
const translationModel = values["translation-model"] ?? DEFAULT_TRANSLATION_MODEL;
const translationConfig = loadTranslationConfig(translateEnabled, {}, env);
if (translationConfig.isErr()) {
  throw new Error(`translation configuration failed: ${translationConfig.error.message}`);
}
const translationLoopback = env["URBUDDY_TRANSLATE_ENDPOINT"] !== undefined;
const translationPreflightResult = translationPreflight({
  enabled: translateEnabled,
  env,
  model: translationModel,
  supportedModels: SUPPORTED_TRANSLATION_MODELS,
  maxRequests: 16,
  maxOutputTokens: 1_024,
  maxContextUtterances: 5,
  maxInputTokensPerRequest: 600,
  sourceLanguage: translationConfig.value.enabled ? translationConfig.value.sourceLanguage : "auto",
  targetLanguage: translationConfig.value.enabled ? translationConfig.value.targetLanguage : "id",
  loopback: translationLoopback,
});
process.stdout.write(`${formatTranslationPreflight(translationPreflightResult)}\n`);

const preflight = runPreflight({
  env,
  providerId: env["URBUDDY_STT_PROVIDER"] ?? "muse",
  modelId: model,
  ownerAuthorized,
  authorizationReference: values.authorization,
  maxAudioSeconds,
  maxAttempts,
  maxBillableSeconds: maxAudioSeconds * maxAttempts,
  spendingCeilingUsd: 0.01,
  fixtureDurationMs: manifest.audioMs,
  fixtureSampleRate: manifest.sampleRate,
  fixtureChannels: 1,
  fixtureProvenance: FIXTURE_PROVENANCE,
  cumulativeBudget: { allowed: budget.allowed, detail: budget.detail },
  watchdogConnectionSeconds: connectionSeconds,
  watchdogFinalizationSeconds: drainSeconds,
  ...(loopbackEndpoint === undefined ? {} : { loopbackEndpoint }),
});
process.stdout.write(`${formatPreflight(preflight)}\n`);
process.stdout.write(
  `vocabulary: ${vocabulary.vocabularyId} (${keywords.length} terms, sent to the provider handshake)\n`,
);
process.stdout.write(
  `limits: transmitted audio ${maxAudioSeconds}s, watchdog allowances ` +
    `connection ${connectionSeconds}s and finalization ${drainSeconds}s, ` +
    `watchdog ${maxAudioSeconds + connectionSeconds + drainSeconds}s\n`,
);
if (preflight.blocked || !budget.allowed || translationPreflightResult.blocked) {
  process.stdout.write(
    "\nNo provider request was issued. Exact launch command after owner authorization:\n" +
      "  pnpm lab:muse-qualification -- --owner-authorized --authorization <owner-reference>\n",
  );
  process.exit(2);
}

const opened = await openWavSource(fixturePath, { pacing: "realtime" });
if (opened.isErr()) {
  throw new Error(
    `qualification fixture could not be opened: ${opened.error.message}. ` +
      "Generate it with: node lab/audio-slice/qualification/generate-audio.mjs",
  );
}

const lines: TraceRow[] = [];
const startedMonoMs = performance.now();
const monoNow = (): number => Math.round((performance.now() - startedMonoMs) * 1000) / 1000;
const emit = (
  kind: string,
  detail: string,
  data?: Readonly<Record<string, unknown>>,
  monoMs: number = monoNow(),
): void => {
  lines.push({
    kind,
    monoMs: Math.round(monoMs * 1000) / 1000,
    elapsedMs: Math.round(performance.now() - startedMonoMs),
    detail,
    ...(data === undefined ? {} : { data }),
  });
};

interface SourceChunk {
  readonly index: number;
  readonly startSample: number;
  readonly frames: number;
  readonly monoMs: number;
}
const sourceChunks: SourceChunk[] = [];
let sourceFramesTotal = 0;
let sourceFramesDelivered = 0;

const recordingSource: CaptureSource = {
  items: async function* (signal: AbortSignal): AsyncIterable<SourceItem> {
    for await (const item of opened.value.items(signal)) {
      if (item.type === "audio") {
        sourceChunks.push({
          index: sourceChunks.length,
          startSample: item.chunk.startSample,
          frames: item.chunk.samples.length,
          monoMs: monoNow(),
        });
        sourceFramesTotal += item.chunk.samples.length;
        sourceFramesDelivered += item.chunk.samples.length;
      }
      if (item.type === "end") {
        sourceFramesTotal = item.end.sourceFrames;
      }
      yield item;
    }
  },
  stop: () => opened.value.stop(),
  dispose: () => opened.value.dispose(),
};

const providerEnv: Readonly<Record<string, string | undefined>> =
  loopbackEndpoint === undefined ? env : { ...env, URBUDDY_TRANSCRIBE_ENDPOINT: loopbackEndpoint };
const provider = createMuseProviderFromEnv(providerEnv, model);
if (provider.isErr()) {
  throw new Error(`provider configuration failed: ${provider.error.message}`);
}

let comprehension: ComprehensionEngine | undefined;
const feed = new RuntimeFeed({
  sessionId: "muse-qualification",
  streamId: "main",
  provider: [],
  authoredTranscripts: [],
  translations: [],
  intelligence: [],
  gapSkips: [],
  onOutput: (output) => {
    comprehension?.accept(output);
  },
});
feed.start();

const operation = new AbortController();
if (translationConfig.value.enabled) {
  const translator = createTranslationProviderFromEnv(env, translationModel);
  if (translator.isErr()) {
    throw new Error(`translation provider failed: ${translator.error.message}`);
  }
  comprehension = new ComprehensionEngine({
    provider: translator.value,
    languages: translationConfig.value,
    signal: operation.signal,
    domain: feed.domain,
    enableProvisionals: false,
    onPublished: () => {
      requestRender();
    },
  });
  emit(
    "translation-enabled",
    `model=${translator.value.modelId} provider=${translator.value.providerId}`,
    { model: translator.value.modelId, providerId: translator.value.providerId },
  );
}
let transmittedFrames = 0;
let pairingMismatch = 0;
emit("session-initiation", `provider=muse model=${model} mode=${mode}`, {
  providerId: "muse",
  modelId: model,
  mode,
  keywords: keywords.length,
  vocabularyId: vocabulary.vocabularyId,
});

let sendCounter = 0;
const instrumented = instrumentProvider(
  provider.value,
  {
    maxAudioSeconds,
    maxBillableSeconds: maxAudioSeconds * maxAttempts,
    maxAttempts,
    pricePerHourUsd: MUSE_PRICE_PER_HOUR_USD,
  },
  (observation: ProviderObservation) => {
    if (observation.kind === "audio-sent") {
      const sendIndex = sendCounter;
      sendCounter += 1;
      const frames = (observation.bytes ?? 0) / 2;
      transmittedFrames += frames;
      const chunk = sourceChunks[sendIndex];
      if (chunk === undefined || chunk.frames !== frames) pairingMismatch += 1;
      emit("audio-sent", observation.detail, {
        sendIndex,
        bytes: observation.bytes ?? 0,
        frames,
        cumulativeFrames: transmittedFrames,
        sourceStartSample: chunk?.startSample,
        sourceFrames: chunk?.frames,
        paired: chunk !== undefined && chunk.frames === frames,
      });
      return;
    }
    if (observation.kind === "provider-event") {
      const detail = observation.detail;
      if (detail.startsWith("connectionEpoch")) {
        emit("websocket-established", detail, { epoch: 0 });
        return;
      }
      if (detail.startsWith("partial")) {
        const turn = detail.match(/turn=([^ ]+)/)?.[1] ?? "";
        const text = detail.split("text=")[1] ?? "";
        pendingPartials.push({ turn, text, monoMs: observation.monoMs });
        emit("partial-received", detail, { turn, text, providerMonoMs: observation.monoMs });
        return;
      }
      if (detail.startsWith("completed")) {
        const turn = detail.match(/turn=([^ ]+)/)?.[1] ?? "";
        const text = detail.split("text=")[1] ?? "";
        pendingFinals.push({ turn, text, monoMs: observation.monoMs });
        emit("final-received", detail, { turn, text, providerMonoMs: observation.monoMs });
        return;
      }
      if (detail.startsWith("progress")) {
        emit("provider-progress", detail, {
          audioProcessedMs: Number(detail.match(/audioProcessedMs=([0-9]+)/)?.[1] ?? 0),
        });
        return;
      }
      emit("provider-event", detail);
      return;
    }
    emit(observation.kind, observation.detail);
  },
  (detail: string) => {
    emit("limit-abort", detail);
    operation.abort();
  },
  () => monoNow(),
);

interface PendingProviderEvent {
  readonly turn: string;
  readonly text: string;
  readonly monoMs: number;
}
const pendingPartials: PendingProviderEvent[] = [];
const pendingFinals: PendingProviderEvent[] = [];
const takePending = (
  queue: PendingProviderEvent[],
  text: string,
): PendingProviderEvent | undefined => {
  const index = queue.findIndex((item) => item.text === text);
  if (index === -1) return queue.shift();
  const item = queue[index];
  queue.splice(index, 1);
  return item;
};

const holder: { session: Session } = {
  session: { ...initialSession(feed.domain), running: true, assistanceEnabled: false },
};
let finished = false;
let shuttingDown = false;
const finish = (code: number): void => {
  if (finished) return;
  finished = true;
  const cpu = process.cpuUsage();
  for (const mark of feed.instrumentation.applied) {
    emit("runtime-applied", `${mark.utteranceId} r${mark.revision}`, {
      utteranceId: mark.utteranceId,
      revision: mark.revision,
      kind: mark.kind,
      monoMs: mark.monoMs,
    });
  }
  for (const mark of feed.instrumentation.projected) {
    emit("projection-updated", `${mark.utteranceId} r${mark.revision}`, {
      utteranceId: mark.utteranceId,
      revision: mark.revision,
      kind: mark.kind,
      monoMs: mark.monoMs,
    });
  }
  emit(
    "shutdown",
    `code=${code} cpuUserMs=${Math.round(cpu.user / 1000)} cpuSystemMs=${Math.round(cpu.system / 1000)} ` +
      `rssBytes=${process.memoryUsage().rss} ` +
      `transmittedSeconds=${instrumented.transmittedSeconds().toFixed(2)} ` +
      `estimatedCostUsd=${instrumented.estimatedCostUsd().toFixed(6)} ` +
      `utterances=${feed.domain.utterances.length} ` +
      `discontinuities=${feed.domain.gapDetails.length} ` +
      `duplicates=${feed.domain.duplicates} stale=${feed.domain.stale} rejected=${feed.domain.rejected.length}`,
    {
      code,
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      rssBytes: process.memoryUsage().rss,
      transmittedSeconds: Number(instrumented.transmittedSeconds().toFixed(3)),
      estimatedCostUsd: Number(instrumented.estimatedCostUsd().toFixed(6)),
      sourceFrames: sourceFramesTotal,
      transmittedFrames,
      sourceFramesDelivered,
      pairingMismatch,
      utterances: feed.domain.utterances.length,
      discontinuities: feed.domain.gapDetails.length,
      duplicates: feed.domain.duplicates,
      stale: feed.domain.stale,
      rejected: feed.domain.rejected.length,
      renders: renderRequests,
      renderCompletions: renderCompletions,
      progressEvents: progressEvents,
    },
  );
  mkdirSync(TRACE_DIR, { recursive: true });
  const target = values.output ?? join(TRACE_DIR, `muse-${Date.now()}.jsonl`);
  writeFileSync(target, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  process.stdout.write(`trace: ${target}\n`);
  const record: AttemptRecord = {
    at: new Date().toISOString(),
    authorization: values.authorization ?? "none",
    transmittedSeconds: Number(instrumented.transmittedSeconds().toFixed(3)),
    estimatedCostUsd: Number(instrumented.estimatedCostUsd().toFixed(6)),
    fixtureSha256,
    trace: target,
  };
  if (loopbackEndpoint === undefined) {
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    writeLedger(LEDGER_PATH, { attempts: [...ledger.attempts, record] });
  }
  process.exitCode = code;
};

const controller: AppController = {
  actUser: (key, clockMs) => {
    holder.session = actUser(holder.session, key, clockMs);
    emit("input", key);
  },
  pauseToggle: () => {
    emit("pause-unavailable", "the live qualification has no local playback to pause");
  },
  shutdown: finish,
  snapshot: () => holder.session,
  clockMs: () => Math.round(performance.now() - startedMonoMs),
};

let renderRequests = 0;
let renderCompletions = 0;
let progressEvents = 0;
let clockRenderAtMs = 0;

const output: string[] = [];
let outputOffset = 0;
const stdoutProxy = new Proxy(process.stdout, {
  get(target, property, receiver): unknown {
    if (property === "write") {
      return (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return (target.write as (...args: unknown[]) => boolean)(chunk, ...rest);
      };
    }
    const value = Reflect.get(target, property, receiver) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  },
});

const app =
  values.headless === true
    ? undefined
    : render(<AdaptiveApp controller={controller} />, {
        stdout: stdoutProxy as NodeJS.WritableStream,
        exitOnCtrlC: false,
      });

const latestUtterance = (): {
  readonly utteranceId: string;
  readonly revision: number;
  readonly text: string;
} => {
  const row = feed.domain.utterances[feed.domain.utterances.length - 1];
  if (row === undefined) return { utteranceId: "none", revision: 0, text: "" };
  return { utteranceId: row.key, revision: row.revision, text: row.text };
};

const renderFrame = (): string =>
  renderToString(
    React.createElement(AdaptiveScreen, {
      state: { ...holder.session, atMs: Math.round(performance.now() - startedMonoMs) },
      size: { columns: 86, rows: 28 },
    }),
    { columns: 86 },
  );

const renderObserver = createRenderObserver(
  (observation) => {
    if (observation.kind === "render-requested") {
      renderRequests += 1;
    } else {
      renderCompletions += 1;
    }
    emit(observation.kind, `utterance ${observation.utteranceId} r${observation.revision}`, {
      utteranceId: observation.utteranceId,
      revision: observation.revision,
      ...(observation.confirmed === undefined ? {} : { confirmed: observation.confirmed }),
    });
  },
  () => monoNow(),
);

const requestRender = (): void => {
  const target = latestUtterance();
  holder.session = touchLiveView({
    ...holder.session,
    atMs: Math.round(performance.now() - startedMonoMs),
    running: !operation.signal.aborted,
  });
  const handle = renderObserver.request(target);
  const from = outputOffset;
  if (app === undefined) {
    const frame = renderFrame();
    output.push(frame);
    outputOffset = output.length;
    renderObserver.complete(handle, frame);
    return;
  }
  app.rerender(<AdaptiveApp controller={controller} />);
  void app.waitUntilRenderFlush().then(() => {
    const written = output.slice(from).join("");
    outputOffset = output.length;
    renderObserver.complete(handle, written);
  });
};

const segmentEnds = Object.entries(manifest.spans)
  .map(([id, span]) => ({ id, endMs: span.startMs + span.durationMs }))
  .toSorted((left, right) => left.endMs - right.endMs);
let segmentIndex = 0;

const timeouts = qualificationTimeouts({
  maxTransmittedAudioSeconds: maxAudioSeconds,
  connectionSeconds,
  finalizationSeconds: drainSeconds,
  fixtureDurationSeconds: manifest.audioMs / 1000,
});
const timeoutFit = timeoutDecision(timeouts, manifest.audioMs / 1000);
process.stdout.write(
  `timeout fit: ${timeoutFit.detail} -> ${timeoutFit.fits ? "fits" : "exceeds"}\n`,
);
const watchdogMs = timeouts.watchdogSeconds * 1000;

const clockTimer = setInterval(() => {
  const now = Math.round(performance.now() - startedMonoMs);
  const decision = decideRender("clock", now - clockRenderAtMs);
  if (!decision.render) return;
  clockRenderAtMs = now;
  requestRender();
}, 250);

const transcription = await runTranscription({
  source: recordingSource,
  provider: instrumented.provider,
  signal: operation.signal,
  mode: mode === "diarization" ? "diarization" : "endpointing",
  keywords,
  durationMs: watchdogMs,
  onEvent: async (event: TranscriptEvent) => {
    const elapsed = Math.round(performance.now() - startedMonoMs);
    while (segmentIndex < segmentEnds.length) {
      const segment = segmentEnds[segmentIndex];
      if (segment === undefined || segment.endMs > elapsed) break;
      segmentIndex += 1;
      emit("segment-end", `${segment.id} at ${segment.endMs}ms of fixture audio`, {
        segmentId: segment.id,
        sourcePositionMs: segment.endMs,
      });
    }
    if (event.type === "progress") {
      progressEvents += 1;
      const decision = decideRender("progress", 0, { renderProgress });
      if (!decision.render) return Promise.resolve();
    }
    if (event.type === "partial" || event.type === "final") {
      const queue = event.type === "partial" ? pendingPartials : pendingFinals;
      const provider = takePending(queue, event.text);
      emit(`${event.type}-committed`, `${event.utteranceId} r${event.revision}`, {
        utteranceId: event.utteranceId,
        revision: event.revision,
        text: event.text,
        turn: provider?.turn,
        providerMonoMs: provider?.monoMs,
        canonicalMonoMs: monoNow(),
      });
    }
    if (event.type === "discontinuity") {
      emit("reducer-accepted-discontinuity", event.detail, { reason: event.reason });
    }
    comprehension?.ingest(event);
    feed.ingestCanonicalEvent(event, elapsed);
    await feed.idle();
    const decision = decideRender(
      event.type === "partial" ? "partial" : event.type === "final" ? "final" : "discontinuity",
      0,
    );
    if (decision.render) requestRender();
    return Promise.resolve();
  },
});

const shutdown = async (code: number): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(clockTimer);
  operation.abort();
  let unresolved = 0;
  if (comprehension !== undefined) {
    const settled = await comprehension.finish();
    unresolved =
      settled.unresolvedInvocations +
      (settled.unresolvedPublication ? 1 : 0) +
      settled.publicationFailures;
    emit(
      "translation-settlement",
      `committed=${settled.committed} failed=${settled.failedInvocations} cancelled=${settled.cancelledInvocations} ` +
        `unresolved=${settled.unresolvedInvocations} publicationFailures=${settled.publicationFailures}`,
      {
        committed: settled.committed,
        failed: settled.failedInvocations,
        cancelled: settled.cancelledInvocations,
        unresolved: settled.unresolvedInvocations,
        publicationFailures: settled.publicationFailures,
      },
    );
  }
  feed.finish();
  await feed.completion();
  finish(unresolved > 0 ? 1 : code);
};

if (transcription.isErr()) {
  emit("failure", `${transcription.error.code}: ${transcription.error.message}`, {
    code: transcription.error.code,
    message: transcription.error.message,
  });
  await shutdown(1);
} else {
  const summary = transcription.value;
  emit(
    "provider-summary",
    `providerId=${summary.providerId} modelId=${summary.modelId} mode=${summary.mode} ` +
      `finals=${summary.finals} partials=${summary.partials} discontinuities=${summary.discontinuities} ` +
      `providerSessionId=${summary.providerSessionId ?? "none"}`,
    {
      providerId: summary.providerId,
      modelId: summary.modelId,
      mode: summary.mode,
      finals: summary.finals,
      partials: summary.partials,
      discontinuities: summary.discontinuities,
      providerSessionId: summary.providerSessionId ?? "none",
    },
  );
  if (comprehension !== undefined) {
    const summary = await comprehension.finish();
    for (const observation of comprehension.observations) {
      emit(
        `translation-${observation.type}`,
        `${observation.utteranceId} r${observation.revision}`,
        {
          utteranceId: observation.utteranceId,
          revision: observation.revision,
          sourceArrivedMs: observation.sourceArrivedMs,
          queueMs: observation.queueMs,
          responseMs: observation.responseMs,
          publicationMs: observation.publicationMs,
          observedMonoMs: observation.monoMs,
        },
      );
    }
    emit(
      "translation-summary",
      `committed=${summary.committed} provisionals=${summary.provisionals} requests=${summary.requests} ` +
        `responses=${summary.responses} failed=${summary.failedInvocations} cancelled=${summary.cancelledInvocations} ` +
        `unresolved=${summary.unresolvedInvocations} staleRejected=${summary.staleRejected} degraded=${summary.degraded} ` +
        `uncovered=${summary.uncovered} inputTokens=${summary.inputTokens ?? "unknown"} ` +
        `outputTokens=${summary.outputTokens ?? "unknown"}`,
      {
        committed: summary.committed,
        provisionals: summary.provisionals,
        requests: summary.requests,
        responses: summary.responses,
        failedInvocations: summary.failedInvocations,
        cancelledInvocations: summary.cancelledInvocations,
        unresolvedInvocations: summary.unresolvedInvocations,
        staleRejected: summary.staleRejected,
        degraded: summary.degraded,
        uncovered: summary.uncovered,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        providerId: summary.providerId,
        modelId: summary.modelId,
        promptVersion: summary.promptVersion,
      },
    );
  }
  process.stdout.write(`\n${renderFrame()}\n`);
  await shutdown(0);
}
