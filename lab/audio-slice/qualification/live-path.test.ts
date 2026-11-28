import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToString } from "ink";
import { ok } from "neverthrow";
import React from "react";
import { describe, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { createMuseProviderFromEnv } from "../../../src/adapters/speech/muse.js";
import type { CaptureSource, SourceItem } from "../../../src/modules/perception/audio.js";
import { runTranscription, type TranscriptEvent } from "../../../src/modules/perception/speech.js";
import { RuntimeFeed } from "../feed.js";
import { AdaptiveScreen } from "../screen.js";
import { type Session, type UserState } from "../session.js";

import { instrumentProvider, type ProviderObservation } from "./instrumented-provider.js";

const SAMPLE_RATE = 16_000;

interface ScriptedServer {
  readonly endpoint: string;
  readonly seen: string[];
  readonly connections: number;
  close(): Promise<void>;
}

async function startScriptedServer(
  script: (socket: WebSocket, seen: string[]) => void,
): Promise<ScriptedServer> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const seen: string[] = [];
  let connections = 0;
  server.on("connection", (socket: WebSocket) => {
    connections += 1;
    script(socket, seen);
  });
  return {
    endpoint: `ws://127.0.0.1:${port}`,
    seen,
    get connections() {
      return connections;
    },
    close: async () => {
      for (const client of server.clients) client.terminate();
      server.close();
      await once(server, "close");
    },
  };
}

function scriptedSource(seconds: number): CaptureSource {
  const totalSamples = SAMPLE_RATE * seconds;
  let stopped = false;
  return {
    items: async function* (signal: AbortSignal): AsyncIterable<SourceItem> {
      yield {
        type: "format",
        seq: 0,
        format: { sampleRate: SAMPLE_RATE, channels: 1 },
      };
      const chunkSamples = 1024;
      let seq = 1;
      let delivered = 0;
      let chunks = 0;
      while (delivered < totalSamples) {
        if (signal.aborted || stopped) break;
        const count = Math.min(chunkSamples, totalSamples - delivered);
        const samples = new Float32Array(count);
        for (let index = 0; index < count; index += 1) {
          samples[index] = Math.sin((2 * Math.PI * 220 * (delivered + index)) / SAMPLE_RATE) * 0.2;
        }
        yield { type: "audio", chunk: { seq, startSample: delivered, samples } };
        seq += 1;
        chunks += 1;
        delivered += count;
        await new Promise((resolve) => setImmediate(resolve));
      }
      yield {
        type: "end",
        seq,
        end: {
          captured: totalSamples,
          delivered: chunks,
          dropped: 0,
          reason: "completed",
          sourceFrames: totalSamples,
        },
      };
    },
    stop: async () => {
      stopped = true;
    },
    dispose: async () => ok(undefined),
  };
}

function blankUser(): UserState {
  return {
    view: "live",
    question: undefined,
    revealedHistory: false,
    editing: false,
    text: "",
    noteAtMs: undefined,
    original: false,
    showAnswer: false,
    help: false,
    understoodKey: undefined,
    understoodAtMs: undefined,
    lastViewedKey: undefined,
    contextSel: undefined,
    guidanceDismissed: true,
    scroll: 0,
  };
}

interface LiveRun {
  readonly feed: RuntimeFeed;
  readonly observations: ProviderObservation[];
  readonly canonical: TranscriptEvent[];
  readonly outcome: { readonly ok: boolean; readonly message: string };
  readonly sentBytes: number;
}

async function runLivePath(
  endpoint: string,
  options: { readonly seconds?: number; readonly maxAudioSeconds?: number } = {},
): Promise<LiveRun> {
  const observations: ProviderObservation[] = [];
  const canonical: TranscriptEvent[] = [];
  const feed = new RuntimeFeed({
    sessionId: "muse-test",
    streamId: "main",
    provider: [],
    authoredTranscripts: [],
    translations: [],
    intelligence: [],
    gapSkips: [],
  });
  feed.start();
  const operation = new AbortController();
  const provider = createMuseProviderFromEnv(
    { URBUDDY_TRANSCRIBE_ENDPOINT: endpoint, URBUDDY_META_API_KEY: "operator-secret-value" },
    "muse-voice-transcribe-1.0",
  );
  expect(provider.isOk()).toBe(true);
  if (provider.isErr()) throw new Error(provider.error.message);
  const instrumented = instrumentProvider(
    provider.value,
    {
      maxAudioSeconds: options.maxAudioSeconds ?? 30,
      maxBillableSeconds: 90,
      maxAttempts: 3,
      pricePerHourUsd: 0.18,
    },
    (observation) => observations.push(observation),
    () => operation.abort(),
  );
  const outcome = await runTranscription({
    source: scriptedSource(options.seconds ?? 1),
    provider: instrumented.provider,
    signal: operation.signal,
    mode: "endpointing",
    keywords: [],
    onEvent: (event) => {
      canonical.push(event);
      feed.ingestCanonicalEvent(event, 0);
      return Promise.resolve();
    },
  });
  feed.finish();
  await feed.completion();
  return {
    feed,
    observations,
    canonical,
    outcome: outcome.isOk()
      ? { ok: true, message: "ok" }
      : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` },
    sentBytes: instrumented.transmittedBytes(),
  };
}

function happyProtocol(socket: WebSocket, seen: string[]): void {
  socket.once("message", (_data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      socket.send(JSON.stringify({ sessionId: "loopback-session" }));
    }
  });
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      seen.push("binary");
      return;
    }
    const text = data.toString();
    seen.push(text);
    if (text.includes("endStream")) {
      socket.send(JSON.stringify({ type: "speechStart", turnId: 1, audioProcessedMs: 100 }));
      socket.send(
        JSON.stringify({
          type: "transcript",
          transcript: "the cache lock",
          final: false,
          audioProcessedMs: 150,
        }),
      );
      socket.send(
        JSON.stringify({
          type: "transcript",
          transcript: "the cache lock is held",
          final: false,
          audioProcessedMs: 200,
        }),
      );
      socket.send(JSON.stringify({ type: "speechEnd", turnId: 1, audioProcessedMs: 250 }));
      socket.send(
        JSON.stringify({
          type: "speechComplete",
          turnId: 1,
          transcript: "The cache lock is held.",
          audioProcessedMs: 250,
        }),
      );
      socket.close(1000);
    }
  });
}

describe("live provider path (local loopback, no paid request)", () => {
  test("a provider session drives canonical events into the runtime and the renderer", async () => {
    const server = await startScriptedServer(happyProtocol);
    try {
      const run = await runLivePath(server.endpoint);
      expect(run.outcome.ok, run.outcome.message).toBe(true);
      expect(run.sentBytes).toBeGreaterThan(0);
      expect(run.observations.some((item) => item.kind === "session-open")).toBe(true);
      expect(run.observations.some((item) => item.kind === "audio-sent")).toBe(true);
      expect(run.canonical.some((event) => event.type === "partial")).toBe(true);
      expect(run.canonical.some((event) => event.type === "final")).toBe(true);

      const utterance = run.feed.domain.utterances[0];
      expect(utterance?.text).toBe("The cache lock is held.");
      expect(utterance?.finalized).toBe(true);
      expect(run.feed.domain.stale).toBe(0);
      expect(run.feed.domain.rejected).toEqual([]);

      const session: Session = {
        domain: run.feed.domain,
        user: blankUser(),
        atMs: 0,
        running: false,
        assistanceEnabled: false,
      };
      const frame = renderToString(
        React.createElement(AdaptiveScreen, { state: session, size: { columns: 86, rows: 28 } }),
        { columns: 86 },
      );
      expect(frame).toContain("The cache lock is held.");
      expect(frame).toContain("Terjemahan tidak diaktifkan.");
    } finally {
      await server.close();
    }
  });

  test("the operator credential never reaches the socket", async () => {
    const server = await startScriptedServer(happyProtocol);
    try {
      await runLivePath(server.endpoint);
      expect(server.seen.join("|")).not.toContain("operator-secret-value");
    } finally {
      await server.close();
    }
  });

  test("a provider disconnect fails explicitly instead of reporting success", async () => {
    const server = await startScriptedServer((socket) => {
      socket.once("message", (_data: Buffer, isBinary: boolean) => {
        if (!isBinary) socket.close(1008, "protocol rejection");
      });
    });
    try {
      const run = await runLivePath(server.endpoint);
      expect(run.outcome.ok).toBe(false);
      expect(run.outcome.message.length).toBeGreaterThan(0);
      expect(server.connections).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("the audio budget refuses to exceed the configured limit", async () => {
    const server = await startScriptedServer(happyProtocol);
    try {
      const run = await runLivePath(server.endpoint, { seconds: 2, maxAudioSeconds: 0.05 });
      expect(run.outcome.ok).toBe(false);
      expect(run.observations.some((item) => item.kind === "limit-reached")).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("a duplicate provider event does not duplicate projected state", async () => {
    const server = await startScriptedServer((socket) => {
      socket.once("message", (_data: Buffer, isBinary: boolean) => {
        if (!isBinary) socket.send(JSON.stringify({ sessionId: "loopback-session" }));
      });
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        if (!data.toString().includes("endStream")) return;
        socket.send(JSON.stringify({ type: "speechStart", turnId: 1, audioProcessedMs: 100 }));
        socket.send(
          JSON.stringify({
            type: "transcript",
            transcript: "the cache lock",
            final: false,
            audioProcessedMs: 150,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "transcript",
            transcript: "the cache lock",
            final: false,
            audioProcessedMs: 160,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "speechComplete",
            turnId: 1,
            transcript: "The cache lock.",
            audioProcessedMs: 200,
          }),
        );
        socket.close(1000);
      });
    });
    try {
      const run = await runLivePath(server.endpoint);
      expect(run.outcome.ok, run.outcome.message).toBe(true);
      expect(run.feed.domain.utterances).toHaveLength(1);
      expect(run.feed.domain.utterances[0]?.text).toBe("The cache lock.");
    } finally {
      await server.close();
    }
  });
});

describe("qualification fixture isolation", () => {
  test("the runtime path never reads the reference transcript", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const runtimeFiles = [
      "../feed.ts",
      "../screen.tsx",
      "../session.ts",
      "../projection.ts",
      "./run-muse.tsx",
      "./instrumented-provider.ts",
      "./preflight.ts",
    ];
    for (const file of runtimeFiles) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, `${file} must not read the reference transcript`).not.toContain(
        "reference.json",
      );
    }
  });
});
