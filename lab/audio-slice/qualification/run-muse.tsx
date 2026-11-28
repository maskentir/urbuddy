import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { render, renderToString } from "ink";
import React from "react";

import { openWavSource } from "../../../src/adapters/audio/wav-source.js";
import { createMuseProviderFromEnv } from "../../../src/adapters/speech/muse.js";
import { loadOperationEnvironment } from "../../../src/modules/config/environment.js";
import { runTranscription, type TranscriptEvent } from "../../../src/modules/perception/speech.js";
import { RuntimeFeed } from "../feed.js";
import { AdaptiveApp, AdaptiveScreen, type AppController } from "../screen.js";
import { actUser, initialSession, touchLiveView, type Session } from "../session.js";

import {
  instrumentProvider,
  MUSE_PRICE_PER_HOUR_USD,
  type ProviderObservation,
} from "./instrumented-provider.js";
import { FIXTURE_PROVENANCE, formatPreflight, runPreflight } from "./preflight.js";

const HELP = `urbuddy Muse STT qualification (real provider, paid, owner authorized)

  tsx lab/audio-slice/qualification/run-muse.tsx --help

Requires an explicit owner authorization flag and a configured credential.
The run is bounded to 30 s of audio per attempt and three attempts.
Translation and intelligence assistance are disabled for this run.`;

const here = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_FIXTURE = join(here, "audio", "qualification.wav");
const DEFAULT_MANIFEST = join(here, "audio", "manifest.json");
const TRACE_DIR = join(here, "trace");

interface TraceLine {
  readonly kind: string;
  readonly monoMs: number;
  readonly elapsedMs: number;
  readonly detail: string;
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
    headless: { type: "boolean" },
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
const model = values.model ?? "muse-voice-transcribe-1.0";
const mode = values.mode ?? "endpointing";
const fixturePath = values.fixture ?? DEFAULT_FIXTURE;
const ownerAuthorized = values["owner-authorized"] === true;
const loopbackEndpoint = values.loopback;

const environment = loadOperationEnvironment(process.env, values["env-file"]);
if (environment.isErr()) {
  throw new Error(`environment could not be loaded: ${environment.error.message}`);
}
const env = environment.value;

const manifest = JSON.parse(readFileSync(DEFAULT_MANIFEST, "utf8")) as {
  audioMs: number;
  sampleRate: number;
  spans: Record<string, { startMs: number; durationMs: number }>;
};

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
  ...(loopbackEndpoint === undefined ? {} : { loopbackEndpoint }),
});
process.stdout.write(`${formatPreflight(preflight)}\n`);
if (preflight.blocked) {
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
const source = opened.value;

const providerEnv: Readonly<Record<string, string | undefined>> =
  loopbackEndpoint === undefined ? env : { ...env, URBUDDY_TRANSCRIBE_ENDPOINT: loopbackEndpoint };
const provider = createMuseProviderFromEnv(providerEnv, model);
if (provider.isErr()) {
  throw new Error(`provider configuration failed: ${provider.error.message}`);
}

const lines: TraceLine[] = [];
const startedMonoMs = performance.now();
const emit = (kind: string, detail: string): void => {
  lines.push({
    kind,
    monoMs: Math.round((performance.now() - startedMonoMs) * 1000) / 1000,
    elapsedMs: Math.round(performance.now() - startedMonoMs),
    detail,
  });
};

const feed = new RuntimeFeed({
  sessionId: "muse-qualification",
  streamId: "main",
  provider: [],
  authoredTranscripts: [],
  translations: [],
  intelligence: [],
  gapSkips: [],
});
feed.start();

const operation = new AbortController();
const instrumented = instrumentProvider(
  provider.value,
  {
    maxAudioSeconds,
    maxBillableSeconds: maxAudioSeconds * maxAttempts,
    maxAttempts,
    pricePerHourUsd: MUSE_PRICE_PER_HOUR_USD,
  },
  (observation: ProviderObservation) => {
    emit(observation.kind, observation.detail);
  },
  (detail: string) => {
    emit("limit-abort", detail);
    operation.abort();
  },
);

const holder: { session: Session } = {
  session: { ...initialSession(feed.domain), running: true, assistanceEnabled: false },
};
let finished = false;
const finish = (code: number): void => {
  if (finished) return;
  finished = true;
  const cpu = process.cpuUsage();
  emit(
    "shutdown",
    `code=${code} cpuUserMs=${Math.round(cpu.user / 1000)} cpuSystemMs=${Math.round(cpu.system / 1000)} ` +
      `rssBytes=${process.memoryUsage().rss} ` +
      `transmittedSeconds=${instrumented.transmittedSeconds().toFixed(2)} ` +
      `estimatedCostUsd=${instrumented.estimatedCostUsd().toFixed(6)} ` +
      `utterances=${feed.domain.utterances.length} ` +
      `discontinuities=${feed.domain.gapDetails.length} ` +
      `duplicates=${feed.domain.duplicates} stale=${feed.domain.stale} rejected=${feed.domain.rejected.length}`,
  );
  mkdirSync(TRACE_DIR, { recursive: true });
  const target = values.output ?? join(TRACE_DIR, `muse-${Date.now()}.jsonl`);
  writeFileSync(target, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  process.stdout.write(`trace: ${target}\n`);
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

const segmentEnds = Object.entries(manifest.spans)
  .map(([id, span]) => ({ id, endMs: span.startMs + span.durationMs }))
  .sort((left, right) => left.endMs - right.endMs);
let segmentIndex = 0;

const app = values.headless === true ? undefined : render(<AdaptiveApp controller={controller} />);
const rerender = (): void => {
  holder.session = touchLiveView({
    ...holder.session,
    atMs: Math.round(performance.now() - startedMonoMs),
    running: !operation.signal.aborted,
  });
  app?.rerender(<AdaptiveApp controller={controller} />);
};

const transcription = await runTranscription({
  source,
  provider: instrumented.provider,
  signal: operation.signal,
  mode: mode === "diarization" ? "diarization" : "endpointing",
  keywords: [],
  durationMs: Math.min(maxAudioSeconds * 1000, manifest.audioMs + 2000),
  onEvent: (event: TranscriptEvent) => {
    const elapsed = Math.round(performance.now() - startedMonoMs);
    while (segmentIndex < segmentEnds.length) {
      const segment = segmentEnds[segmentIndex];
      if (segment === undefined || segment.endMs > elapsed) break;
      segmentIndex += 1;
      emit("segment-end", `${segment.id} at ${segment.endMs}ms of fixture audio`);
    }
    emit(
      `canonical-${event.type}`,
      event.type === "partial" || event.type === "final"
        ? `${event.utteranceId} r${event.revision}: ${event.text}`
        : event.detail,
    );
    feed.ingestCanonicalEvent(event, elapsed);
    rerender();
    emit("render-observed", `after ${event.type}`);
    return Promise.resolve();
  },
});

if (transcription.isErr()) {
  emit("failure", `${transcription.error.code}: ${transcription.error.message}`);
  feed.abort();
  await feed.completion();
  finish(1);
} else {
  const summary = transcription.value;
  emit(
    "provider-summary",
    `providerId=${summary.providerId} modelId=${summary.modelId} mode=${summary.mode} ` +
      `finals=${summary.finals} partials=${summary.partials} discontinuities=${summary.discontinuities} ` +
      `providerSessionId=${summary.providerSessionId ?? "none"}`,
  );
  feed.finish();
  await feed.completion();
  const frame = renderToString(
    React.createElement(AdaptiveScreen, {
      state: { ...holder.session, atMs: Math.round(performance.now() - startedMonoMs) },
      size: { columns: 86, rows: 28 },
    }),
    { columns: 86 },
  );
  process.stdout.write(`\n${frame}\n`);
  finish(0);
}
