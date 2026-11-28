import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ok } from "neverthrow";
import { describe, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { createMuseProviderFromEnv } from "../../../src/adapters/speech/muse.js";
import type { CaptureSource, SourceItem } from "../../../src/modules/perception/audio.js";
import { runTranscription } from "../../../src/modules/perception/speech.js";

import {
  QUALIFICATION_LEDGER_LIMITS,
  cumulativeUsage,
  ledgerDecision,
  readLedger,
} from "./ledger.js";
import { qualificationTimeouts, timeoutDecision } from "./limits.js";
import { createRenderObserver } from "./render-observer.js";
import { CLOCK_RENDER_INTERVAL_MS, decideRender } from "./render-policy.js";

const SAMPLE_RATE = 16_000;

interface ScriptedServer {
  readonly endpoint: string;
  readonly handshakes: string[];
  readonly binaryBytes: number;
  readonly endStreamSeen: boolean;
  close(): Promise<void>;
}

async function startScriptedServer(
  script?: (socket: WebSocket, server: ScriptedServer) => void,
): Promise<ScriptedServer> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const handshakes: string[] = [];
  let binaryBytes = 0;
  let endStreamSeen = false;
  const handle: ScriptedServer = {
    endpoint: `ws://127.0.0.1:${port}`,
    handshakes,
    get binaryBytes() {
      return binaryBytes;
    },
    get endStreamSeen() {
      return endStreamSeen;
    },
    close: async () => {
      for (const client of server.clients) client.terminate();
      server.close();
      await once(server, "close");
    },
  };
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        binaryBytes += data.length;
        return;
      }
      const text = data.toString();
      if (text.includes("accessToken")) {
        handshakes.push(text);
        socket.send(JSON.stringify({ sessionId: "loopback-session" }));
        return;
      }
      if (text.includes("endStream")) {
        endStreamSeen = true;
        socket.send(
          JSON.stringify({
            type: "speechComplete",
            turnId: 1,
            transcript: "hello",
            audioProcessedMs: 10,
          }),
        );
        socket.close(1000);
        return;
      }
      script?.(socket, handle);
    });
  });
  return handle;
}

function partialLastChunkSource(totalFrames: number, chunkFrames: number): CaptureSource {
  let delivered = 0;
  return {
    items: async function* (signal: AbortSignal): AsyncIterable<SourceItem> {
      yield {
        type: "format",
        seq: 0,
        format: { sampleRate: SAMPLE_RATE, channels: 1 },
      };
      let seq = 1;
      let chunks = 0;
      while (delivered < totalFrames) {
        if (signal.aborted) break;
        const count = Math.min(chunkFrames, totalFrames - delivered);
        yield {
          type: "audio",
          chunk: { seq, startSample: delivered, samples: new Float32Array(count) },
        };
        seq += 1;
        chunks += 1;
        delivered += count;
      }
      yield {
        type: "end",
        seq,
        end: {
          captured: totalFrames,
          delivered: chunks,
          dropped: 0,
          reason: "completed",
          sourceFrames: totalFrames,
        },
      };
    },
    stop: async () => undefined,
    dispose: async () => ok(undefined),
  };
}

describe("timeout policy", () => {
  test("the watchdog is separate from the transmitted audio ceiling", () => {
    const timeouts = qualificationTimeouts({
      maxTransmittedAudioSeconds: 30,
      connectionSeconds: 15,
      finalizationSeconds: 15,
      fixtureDurationSeconds: 29.53,
    });
    expect(timeouts.maxTransmittedAudioSeconds).toBe(30);
    expect(timeouts.watchdogSeconds).toBe(60);
    expect(timeouts.watchdogSeconds).toBeGreaterThan(timeouts.maxTransmittedAudioSeconds);
    const fit = timeoutDecision(timeouts, 29.53);
    expect(fit.fits).toBe(true);
    expect(fit.detail).toContain("watchdog 60s");
  });

  test("a fixture longer than the audio ceiling is reported as not fitting", () => {
    const timeouts = qualificationTimeouts({
      maxTransmittedAudioSeconds: 30,
      connectionSeconds: 15,
      finalizationSeconds: 15,
      fixtureDurationSeconds: 45,
    });
    expect(timeoutDecision(timeouts, 45).fits).toBe(false);
  });
});

describe("audio transmission regression", () => {
  test("every source frame reaches the provider including the last partial frame", async () => {
    const server = await startScriptedServer();
    const totalFrames = 2_500;
    const chunkFrames = 1_024;
    const provider = createMuseProviderFromEnv(
      { URBUDDY_TRANSCRIBE_ENDPOINT: server.endpoint },
      "muse-voice-transcribe-1.0",
    );
    expect(provider.isOk()).toBe(true);
    if (provider.isErr()) throw new Error(provider.error.message);
    const outcome = await runTranscription({
      source: partialLastChunkSource(totalFrames, chunkFrames),
      provider: provider.value,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: () => Promise.resolve(),
    });
    expect(outcome.isOk(), outcome.isErr() ? outcome.error.message : "").toBe(true);
    expect(server.binaryBytes).toBe(totalFrames * 2);
    expect(server.endStreamSeen).toBe(true);
    await server.close();
  });
});

describe("keyword capability", () => {
  test("the configured vocabulary reaches the provider handshake", async () => {
    const server = await startScriptedServer();
    const vocabulary = JSON.parse(
      readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "vocabulary.json"), "utf8"),
    ) as { vocabularyId: string; terms: string[] };
    const provider = createMuseProviderFromEnv(
      { URBUDDY_TRANSCRIBE_ENDPOINT: server.endpoint },
      "muse-voice-transcribe-1.0",
    );
    expect(provider.isOk()).toBe(true);
    if (provider.isErr()) throw new Error(provider.error.message);
    const outcome = await runTranscription({
      source: partialLastChunkSource(4_800, 1_024),
      provider: provider.value,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: vocabulary.terms,
      onEvent: () => Promise.resolve(),
    });
    expect(outcome.isOk()).toBe(true);
    expect(server.handshakes).toHaveLength(1);
    const handshake = JSON.parse(server.handshakes[0] ?? "{}") as {
      keywords?: string[];
      model?: string;
      mode?: string;
    };
    expect(handshake.keywords).toEqual(vocabulary.terms);
    expect(handshake.model).toBe("muse-voice-transcribe-1.0");
    expect(handshake.mode).toBe("ENDPOINTING");
    await server.close();
  });
});

describe("render instrumentation", () => {
  test("a completion is only confirmed when the written output holds the target text", () => {
    const observations: { kind: string; confirmed?: boolean | undefined }[] = [];
    const observer = createRenderObserver(
      (observation) =>
        observations.push({ kind: observation.kind, confirmed: observation.confirmed }),
      () => 1_000,
    );
    const handle = observer.request({
      utteranceId: "epoch-0-turn-1",
      revision: 2,
      text: "The cache lock is held.",
    });
    observer.complete(handle, "…The cache lock is held.…");
    expect(observations).toHaveLength(2);
    expect(observations[0]?.kind).toBe("render-requested");
    expect(observations[1]?.kind).toBe("render-completed");
    expect(observations[1]?.confirmed).toBe(true);
  });

  test("an unrelated later frame is not proof that a revision was rendered", () => {
    const observations: { kind: string; confirmed?: boolean | undefined }[] = [];
    const observer = createRenderObserver(
      (observation) =>
        observations.push({ kind: observation.kind, confirmed: observation.confirmed }),
      () => 2_000,
    );
    const handle = observer.request({
      utteranceId: "epoch-0-turn-1",
      revision: 1,
      text: "The cache lock is held.",
    });
    observer.complete(handle, "…Unrelated content from a later frame…");
    expect(observations[1]?.confirmed).toBe(false);
  });
});

describe("overlapping render requests", () => {
  test("a later flush cannot attribute its completion to another utterance", () => {
    const observations: {
      kind: string;
      utteranceId: string;
      revision: number;
      confirmed?: boolean | undefined;
    }[] = [];
    const observer = createRenderObserver(
      (observation) =>
        observations.push({
          kind: observation.kind,
          utteranceId: observation.utteranceId,
          revision: observation.revision,
          confirmed: observation.confirmed,
        }),
      () => 1_000,
    );
    const first = observer.request({
      utteranceId: "epoch-0-turn-1",
      revision: 1,
      text: "the first utterance",
    });
    const second = observer.request({
      utteranceId: "epoch-0-turn-2",
      revision: 4,
      text: "the second utterance",
    });
    observer.complete(second, "…the second utterance…");
    observer.complete(first, "…the first utterance…");
    expect(observations.map((entry) => entry.kind)).toEqual([
      "render-requested",
      "render-requested",
      "render-completed",
      "render-completed",
    ]);
    expect(observations[2]?.utteranceId).toBe("epoch-0-turn-2");
    expect(observations[2]?.revision).toBe(4);
    expect(observations[2]?.confirmed).toBe(true);
    expect(observations[3]?.utteranceId).toBe("epoch-0-turn-1");
    expect(observations[3]?.revision).toBe(1);
    expect(observations[3]?.confirmed).toBe(true);
  });
});

describe("progress render policy", () => {
  test("a progress event does not cause a content render", () => {
    expect(decideRender("progress", 0).render).toBe(false);
  });

  test("partials, finals, and discontinuities render immediately", () => {
    expect(decideRender("partial", 0).render).toBe(true);
    expect(decideRender("final", 0).render).toBe(true);
    expect(decideRender("discontinuity", 0).render).toBe(true);
  });

  test("the clock renders at its own slower interval", () => {
    expect(decideRender("clock", CLOCK_RENDER_INTERVAL_MS - 1).render).toBe(false);
    expect(decideRender("clock", CLOCK_RENDER_INTERVAL_MS).render).toBe(true);
  });

  test("the captured first run sequence renders far fewer frames under the new policy", () => {
    const captured = JSON.parse(
      readFileSync(
        join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "captured-sequence.json"),
        "utf8",
      ),
    ) as {
      readonly canonicalEvents: readonly string[];
      readonly rendersObservedUnderTheOldPolicy: number;
    };
    const before = captured.rendersObservedUnderTheOldPolicy;
    const contentRenders = captured.canonicalEvents.filter(
      (kind) => decideRender(kind as "partial", 0).render,
    ).length;
    const clockRenders = Math.ceil(30_000 / CLOCK_RENDER_INTERVAL_MS);
    const after = contentRenders + clockRenders;
    expect(before).toBe(427);
    expect(contentRenders).toBe(68);
    expect(after).toBe(98);
    expect(after).toBeLessThan(before);
  });
});

describe("cumulative qualification ledger", () => {
  test("the ledger persists across invocations and refuses the ceiling", () => {
    const path = join(fileURLToPath(new URL(".", import.meta.url)), "state", "ledger-test.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        attempts: [
          {
            at: "2026-11-28T08:20:35.000Z",
            authorization: "owner-approval-attempt-1",
            transmittedSeconds: 28.68,
            estimatedCostUsd: 0.001434,
            fixtureSha256: "abc",
            trace: "trace-1.jsonl",
          },
        ],
      }),
    );
    const state = readLedger(path);
    const usage = cumulativeUsage(state);
    expect(usage.attempts).toBe(1);
    expect(usage.seconds).toBeCloseTo(28.68, 5);
    expect(usage.costUsd).toBeCloseTo(0.001434, 6);
    const within = ledgerDecision(state, QUALIFICATION_LEDGER_LIMITS, 29.533, 0.001477);
    expect(within.allowed).toBe(true);
    const overCost = ledgerDecision(
      { attempts: [...state.attempts, { ...state.attempts[0]!, estimatedCostUsd: 0.009 }] },
      QUALIFICATION_LEDGER_LIMITS,
      29.533,
      0.001477,
    );
    expect(overCost.allowed).toBe(false);
    expect(overCost.detail).toContain("cumulative cost ceiling");
    const overAttempts = ledgerDecision(
      {
        attempts: [state.attempts[0]!, state.attempts[0]!, state.attempts[0]!],
      },
      QUALIFICATION_LEDGER_LIMITS,
      1,
      0.0001,
    );
    expect(overAttempts.allowed).toBe(false);
    expect(overAttempts.detail).toContain("attempt ceiling");
    const overAudio = ledgerDecision(
      { attempts: [...state.attempts, { ...state.attempts[0]!, transmittedSeconds: 70 }] },
      QUALIFICATION_LEDGER_LIMITS,
      29.533,
      0.001477,
    );
    expect(overAudio.allowed).toBe(false);
    expect(overAudio.detail).toContain("cumulative audio ceiling");
    rmSync(path, { force: true });
  });
});
