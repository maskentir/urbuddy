import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createMuseProvider } from "@adapters/speech/muse";
import { appError, type AppError } from "@kernel/errors";
import type { CaptureSource, SourceItem } from "@modules/perception/audio";
import {
  runTranscription,
  type SpeechProvider,
  type SpeechProviderEvent,
  type SpeechSession,
  type TranscriptEvent,
} from "@modules/perception/speech";
import { createTranscribePort } from "@presentation/transcribe";
import { ok, type Result } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

export interface ScriptConnection {
  readonly socket: WebSocket;
  readonly index: number;
  readonly server: SpeechTestServer;
}

export class SpeechTestServer {
  readonly sockets: WebSocket[] = [];
  readonly receivedAudio: Buffer[] = [];
  readonly receivedText: string[] = [];
  connections = 0;
  readonly closed: Promise<void>;
  private resolveClosed: (() => void) | undefined;
  private readonly wss: WebSocketServer;
  private readonly listening: Promise<void>;

  constructor(private readonly onConnection: (connection: ScriptConnection) => void) {
    this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    this.listening = new Promise<void>((resolve) => this.wss.once("listening", resolve));
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    let openSockets = 0;
    this.wss.on("connection", (socket) => {
      const index = this.connections;
      this.connections += 1;
      this.sockets.push(socket);
      openSockets += 1;
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          this.receivedAudio.push(Buffer.from(data));
        } else {
          this.receivedText.push(data.toString());
        }
      });
      socket.on("close", () => {
        openSockets -= 1;
        if (openSockets === 0) {
          this.resolveClosed?.();
        }
      });
      this.onConnection({ socket, index, server: this });
    });
  }

  async url(): Promise<string> {
    await this.listening;
    const address = this.wss.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no port");
    }
    return `ws://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      try {
        socket.terminate();
      } catch {
        continue;
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

export function acknowledge(socket: WebSocket, sessionId = "test-session-1"): void {
  socket.once("message", (_data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      socket.send(JSON.stringify({ sessionId }));
    }
  });
}

export function trackedSource(items: SourceItem[]): CaptureSource & { stopSeen: boolean } {
  const state = {
    stopSeen: false,
    async *items(): AsyncIterable<SourceItem> {
      for (const item of items) {
        yield item;
      }
    },
    async stop(): Promise<void> {
      state.stopSeen = true;
    },
    async dispose(): Promise<Result<void, AppError>> {
      return ok(undefined);
    },
  };
  return state;
}

export function formatItem(): SourceItem {
  return { type: "format", seq: 0, format: { sampleRate: 24_000, channels: 1 } };
}

export function audioItem(seq: number, startSample: number, frames = 480): SourceItem {
  return {
    type: "audio",
    chunk: { seq, startSample, samples: new Float32Array(frames).fill(0.1) },
  };
}

export function endItem(seq: number, frames: number): SourceItem {
  return {
    type: "end",
    seq,
    end: {
      captured: frames,
      delivered: frames,
      dropped: 0,
      reason: "completed",
      sourceFrames: frames * 480,
    },
  };
}

export class FakeSpeechSession implements SpeechSession {
  readonly encoding = "PCM_24KHZ" as const;
  readonly providerSessionId = "fake-session";
  readonly sent: Buffer[] = [];
  endInputSeen = false;
  terminated = false;
  constructor(
    private readonly script: (session: FakeSpeechSession) => AsyncIterable<SpeechProviderEvent>,
  ) {}

  events(): AsyncIterable<SpeechProviderEvent> {
    return this.script(this);
  }

  async sendAudio(pcm: Buffer): Promise<Result<void, AppError>> {
    this.sent.push(pcm);
    return ok(undefined);
  }

  async endInput(): Promise<void> {
    this.endInputSeen = true;
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }
}
let server: SpeechTestServer | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function finishedTurn(socket: WebSocket, text: string): void {
  socket.send(JSON.stringify({ type: "speechStart", turnId: 1, audioProcessedMs: 100 }));
  socket.send(
    JSON.stringify({
      type: "transcript",
      transcript: "hello",
      final: false,
      audioProcessedMs: 200,
    }),
  );
  socket.send(
    JSON.stringify({ type: "speechComplete", turnId: 1, transcript: text, audioProcessedMs: 300 }),
  );
  socket.close(1000);
}

function fakeSource(frames = 4, sampleRate = 24_000): CaptureSource {
  const items: SourceItem[] = [{ type: "format", seq: 0, format: { sampleRate, channels: 1 } }];
  for (let i = 0; i < frames; i += 1) {
    items.push({
      type: "audio",
      chunk: { seq: i + 1, startSample: i * 480, samples: new Float32Array(480).fill(0.1) },
    });
  }
  items.push({
    type: "end",
    seq: frames + 1,
    end: {
      captured: frames,
      delivered: frames,
      dropped: 0,
      reason: "completed",
      sourceFrames: frames * 480,
    },
  });
  return trackedSource(items);
}

function hangingSource(): CaptureSource & { stopSeen: boolean } {
  const inner = trackedSource([formatItem()]);
  return {
    ...inner,
    get stopSeen(): boolean {
      return inner.stopSeen;
    },
    async *items(signal: AbortSignal): AsyncIterable<SourceItem> {
      yield formatItem();
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(appError("CANCELLED", "transcription cancelled"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(appError("CANCELLED", "transcription cancelled")),
          { once: true },
        );
      });
    },
  };
}

function providerFor(url: string, extra: Record<string, unknown> = {}): SpeechProvider {
  return createMuseProvider({
    apiKey: "test-key",
    testLoopbackEndpoint: url,
    ...extra,
  }) as SpeechProvider;
}

function pacedSource(frames: number, gapMs: number): CaptureSource & { stopSeen: boolean } {
  const items: SourceItem[] = [
    { type: "format", seq: 0, format: { sampleRate: 24_000, channels: 1 } },
  ];
  for (let i = 0; i < frames; i += 1) {
    items.push({
      type: "audio",
      chunk: { seq: i + 1, startSample: i * 480, samples: new Float32Array(480).fill(0.1) },
    });
  }
  items.push({
    type: "end",
    seq: frames + 1,
    end: {
      captured: frames,
      delivered: frames,
      dropped: 0,
      reason: "completed",
      sourceFrames: frames * 480,
    },
  });
  const inner = trackedSource(items);
  return {
    ...inner,
    get stopSeen(): boolean {
      return inner.stopSeen;
    },
    async *items(signal: AbortSignal): AsyncIterable<SourceItem> {
      for await (const item of inner.items(signal)) {
        yield item;
        if (item.type === "audio") {
          await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
        }
      }
    },
  };
}

describe("handshake readiness", () => {
  it("rejects an error frame carrying a sessionId without sending audio", async () => {
    server = new SpeechTestServer(({ socket }) => {
      socket.once("message", () =>
        socket.send(JSON.stringify({ type: "error", message: "bad key", sessionId: "x" })),
      );
    });
    const provider = providerFor(await server.url());
    const opened = await provider.openSession({
      mode: "endpointing",
      encoding: "PCM_24KHZ",
      keywords: [],
      signal: new AbortController().signal,
    });
    expect(opened.isErr()).toBe(true);
    expect(server.receivedAudio.length).toBe(0);
  });

  it("delays audio until a late reconnect acknowledgement arrives", async () => {
    let ackAt = 0;
    const binaryAt: number[] = [];
    server = new SpeechTestServer(({ socket, index }) => {
      if (index === 0) {
        acknowledge(socket);
        socket.on("message", (_data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            socket.close(1011);
          }
        });
        return;
      }
      socket.once("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString().includes("authorization")) {
          setTimeout(() => {
            ackAt = Date.now();
            socket.send(JSON.stringify({ sessionId: "late" }));
          }, 300);
        }
      });
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          binaryAt.push(Date.now());
          return;
        }
        if (data.toString().includes("endStream")) {
          finishedTurn(socket, "Late.");
        }
      });
    });
    const provider = providerFor(await server.url(), { reconnectBackoffMs: [10] });
    const outcome = await runTranscription({
      source: pacedSource(20, 25),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isOk()).toBe(true);
    expect(binaryAt.length).toBeGreaterThan(0);
    expect(binaryAt.every((at) => at >= ackAt)).toBe(true);
  });

  it("cancels during a stalled handshake without sending audio", async () => {
    server = new SpeechTestServer(() => {});
    const controller = new AbortController();
    const provider = providerFor(await server.url());
    const opened = provider.openSession({
      mode: "endpointing",
      encoding: "PCM_24KHZ",
      keywords: [],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await opened;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("CANCELLED");
    }
    expect(server.receivedAudio.length).toBe(0);
  });

  it("accepts recognition events arriving immediately after the acknowledgement", async () => {
    server = new SpeechTestServer(({ socket }) => {
      socket.once("message", (_data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          return;
        }
        socket.send(JSON.stringify({ sessionId: "s" }));
        socket.send(JSON.stringify({ type: "speechStart", turnId: 1, audioProcessedMs: 50 }));
        socket.send(
          JSON.stringify({
            type: "transcript",
            transcript: "early",
            final: false,
            audioProcessedMs: 60,
          }),
        );
      });
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString().includes("endStream")) {
          socket.send(
            JSON.stringify({
              type: "speechComplete",
              turnId: 1,
              transcript: "Early.",
              audioProcessedMs: 70,
            }),
          );
          socket.close(1000);
        }
      });
    });
    const provider = providerFor(await server.url());
    const events: TranscriptEvent[] = [];
    const outcome = await runTranscription({
      source: fakeSource(),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async (event) => {
        events.push(event);
      },
    });
    expect(outcome.isOk()).toBe(true);
    if (outcome.isOk()) {
      expect(outcome.value.finals).toBe(1);
    }
  });

  it("rejects non-provider destinations before connecting", async () => {
    const provider = createMuseProvider({
      apiKey: "k",
      testLoopbackEndpoint: "wss://evil.example.com/asr",
    });
    const started = Date.now();
    const opened = await provider.openSession({
      mode: "endpointing",
      encoding: "PCM_24KHZ",
      keywords: [],
      signal: new AbortController().signal,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(opened.isErr()).toBe(true);
    if (opened.isErr()) {
      expect(opened.error.code).toBe("VALIDATION_FAILED");
    }
    const plaintext = createMuseProvider({
      apiKey: "k",
      testLoopbackEndpoint: "ws://evil.example.com/asr",
    });
    const plain = await plaintext.openSession({
      mode: "endpointing",
      encoding: "PCM_24KHZ",
      keywords: [],
      signal: new AbortController().signal,
    });
    expect(plain.isErr()).toBe(true);
  });
});

describe("termination and reconnect ownership", () => {
  it("performs no reconnect after explicit termination", async () => {
    server = new SpeechTestServer(({ socket }) => {
      acknowledge(socket);
    });
    const provider = providerFor(await server.url());
    const opened = await provider.openSession({
      mode: "endpointing",
      encoding: "PCM_24KHZ",
      keywords: [],
      signal: new AbortController().signal,
    });
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) {
      return;
    }
    await opened.value.terminate();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.connections).toBe(1);
    await server.closed;
  });

  it("performs no reconnect on a fatal provider error", async () => {
    server = new SpeechTestServer(({ socket }) => {
      acknowledge(socket);
      socket.on("message", (_data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          socket.send(JSON.stringify({ type: "error", message: "boom", sessionId: "s" }));
        }
      });
    });
    const provider = providerFor(await server.url());
    const outcome = await runTranscription({
      source: fakeSource(),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isErr()).toBe(true);
    expect(server.connections).toBe(1);
  });

  it("waits through a real backoff and a delayed handshake without early sends", async () => {
    let ackAt = 0;
    const binaryAt: number[] = [];
    server = new SpeechTestServer(({ socket, index }) => {
      if (index === 0) {
        acknowledge(socket);
        socket.on("message", (_data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            socket.close(1011);
          }
        });
        return;
      }
      socket.once("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString().includes("authorization")) {
          setTimeout(() => {
            ackAt = Date.now();
            socket.send(JSON.stringify({ sessionId: "late-backoff" }));
          }, 400);
        }
      });
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          binaryAt.push(Date.now());
          return;
        }
        if (data.toString().includes("endStream")) {
          finishedTurn(socket, "Late backoff.");
        }
      });
    });
    const provider = providerFor(await server.url(), { reconnectBackoffMs: [500] });
    const outcome = await runTranscription({
      source: pacedSource(20, 25),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isOk()).toBe(true);
    expect(server.connections).toBe(2);
    expect(binaryAt.length).toBeGreaterThan(0);
    expect(binaryAt.every((at) => at >= ackAt)).toBe(true);
  });

  it("cancels a sender waiting through backoff and handshake", async () => {
    const secondEpochAudio: Buffer[] = [];
    server = new SpeechTestServer(({ socket, index }) => {
      if (index === 0) {
        acknowledge(socket);
        socket.on("message", (_data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            socket.close(1011);
          }
        });
        return;
      }
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          secondEpochAudio.push(Buffer.from(data));
        }
      });
      socket.once("message", () => {
        setTimeout(() => socket.send(JSON.stringify({ sessionId: "never" })), 5_000);
      });
    });
    const controller = new AbortController();
    const provider = providerFor(await server.url(), { reconnectBackoffMs: [200] });
    const outcome = runTranscription({
      source: pacedSource(40, 20),
      provider,
      signal: controller.signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(server.connections).toBe(2);
    const started = Date.now();
    controller.abort();
    const result = await outcome;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("CANCELLED");
    }
    expect(secondEpochAudio.length).toBe(0);
  });

  it("cancels during reconnect backoff without opening a new connection", async () => {
    server = new SpeechTestServer(({ socket }) => {
      acknowledge(socket);
      socket.on("message", (_data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          socket.close(1011);
        }
      });
    });
    const controller = new AbortController();
    const provider = createMuseProvider({
      apiKey: "test-key",
      testLoopbackEndpoint: await server.url(),
      reconnectBackoffMs: [10_000],
      sleep: (_ms: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(appError("CANCELLED", "speech connection cancelled")),
            { once: true },
          );
        }),
    });
    const outcome = runTranscription({
      source: pacedSource(40, 20),
      provider,
      signal: controller.signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const result = await outcome;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("CANCELLED");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.connections).toBe(1);
  });

  it("settles a stalled send promptly on termination", async () => {
    server = new SpeechTestServer(({ socket }) => {
      acknowledge(socket);
    });
    const provider = createMuseProvider({
      apiKey: "test-key",
      testLoopbackEndpoint: await server.url(),
      maxBufferedBytes: 1,
    });
    const opened = await provider.openSession({
      mode: "endpointing",
      encoding: "PCM_24KHZ",
      keywords: [],
      signal: new AbortController().signal,
    });
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) {
      return;
    }
    const pending = opened.value.sendAudio(Buffer.alloc(96_000, 1));
    setTimeout(() => void opened.value.terminate(), 50);
    const started = Date.now();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.isErr()).toBe(true);
  });

  it("fails the consumer when the inbound queue bound is exceeded", async () => {
    server = new SpeechTestServer(({ socket }) => {
      acknowledge(socket);
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString().includes("endStream")) {
          for (let i = 0; i < 2_000; i += 1) {
            socket.send(JSON.stringify({ type: "audioProgress", audioProcessedMs: i }));
          }
          socket.close(1000);
        }
      });
    });
    const provider = providerFor(await server.url());
    const opened = await provider.openSession({
      mode: "endpointing",
      encoding: "PCM_24KHZ",
      keywords: [],
      signal: new AbortController().signal,
    });
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) {
      return;
    }
    await opened.value.endInput();
    let failure: unknown;
    const seen: string[] = [];
    try {
      for await (const event of opened.value.events()) {
        seen.push(event.type);
      }
    } catch (thrown: unknown) {
      failure = thrown;
    }
    expect(failure).toBeDefined();
    expect(seen).toContain("progress");
    await opened.value.terminate();
  });

  it("bounds reconnect attempts and then fails", async () => {
    server = new SpeechTestServer(({ socket }) => {
      acknowledge(socket);
      socket.on("message", (_data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          socket.close(1011);
        }
      });
    });
    const provider = providerFor(await server.url(), {
      reconnectBackoffMs: [10],
      maxReconnects: 1,
    });
    const outcome = await runTranscription({
      source: pacedSource(40, 20),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isErr()).toBe(true);
    expect(server.connections).toBe(2);
  });

  it("fails finalization when the connection drops after end-of-input", async () => {
    server = new SpeechTestServer(({ socket }) => {
      acknowledge(socket);
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString().includes("endStream")) {
          socket.close(1011);
        }
      });
    });
    const provider = providerFor(await server.url(), { reconnectBackoffMs: [10] });
    const events: TranscriptEvent[] = [];
    const outcome = await runTranscription({
      source: fakeSource(4),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async (event) => {
        events.push(event);
      },
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("RESOURCE_ACQUIRE_FAILED");
    }
    expect(server.connections).toBe(1);
    expect(events.some((event) => event.type === "final")).toBe(false);
  });

  it("resumes with new audio on the new epoch without replaying the old", async () => {
    const secondEpochAudio: number[] = [];
    let endStreamAfterAudio = false;
    server = new SpeechTestServer(({ socket, index }) => {
      acknowledge(socket);
      if (index === 0) {
        socket.on("message", (_data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            socket.close(1011);
          }
        });
        return;
      }
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          secondEpochAudio.push(data.length);
          return;
        }
        if (data.toString().includes("endStream")) {
          endStreamAfterAudio = secondEpochAudio.length > 0;
          finishedTurn(socket, "Recovered.");
        }
      });
    });
    const provider = providerFor(await server.url(), { reconnectBackoffMs: [10] });
    const events: TranscriptEvent[] = [];
    const outcome = await runTranscription({
      source: pacedSource(20, 25),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async (event) => {
        events.push(event);
      },
    });
    expect(outcome.isOk()).toBe(true);
    const retransmitted = secondEpochAudio.reduce((sum, n) => sum + n, 0);
    expect(retransmitted).toBeGreaterThan(0);
    expect(retransmitted).toBeLessThan(20 * 960);
    expect(endStreamAfterAudio).toBe(true);
    expect(events.some((event) => event.type === "discontinuity")).toBe(true);
  });

  it("reports per-utterance incomplete evidence when an epoch ends", async () => {
    server = new SpeechTestServer(({ socket, index }) => {
      acknowledge(socket);
      if (index === 0) {
        socket.once("message", (_data: Buffer, isBinary: boolean) => {
          if (!isBinary) {
            socket.send(JSON.stringify({ type: "speechStart", turnId: 7, audioProcessedMs: 100 }));
            socket.send(
              JSON.stringify({
                type: "transcript",
                transcript: "partial words",
                final: false,
                audioProcessedMs: 200,
              }),
            );
          }
        });
        socket.on("message", (_data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            socket.close(1011);
          }
        });
        return;
      }
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString().includes("endStream")) {
          finishedTurn(socket, "Recovered.");
        }
      });
    });
    const provider = providerFor(await server.url(), { reconnectBackoffMs: [10] });
    const events: TranscriptEvent[] = [];
    const outcome = await runTranscription({
      source: pacedSource(10, 25),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async (event) => {
        events.push(event);
      },
    });
    expect(outcome.isOk()).toBe(true);
    const incomplete = events.filter(
      (event) => event.type === "discontinuity" && event.detail.includes("never finalized"),
    );
    expect(incomplete.length).toBeGreaterThan(0);
  });
});

describe("recognition completeness", () => {
  it("reports an unresolved turn instead of promoting it to final", async () => {
    server = new SpeechTestServer(({ socket }) => {
      acknowledge(socket);
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString().includes("endStream")) {
          socket.send(JSON.stringify({ type: "speechStart", turnId: 1, audioProcessedMs: 100 }));
          socket.send(
            JSON.stringify({
              type: "transcript",
              transcript: "dangling",
              final: false,
              audioProcessedMs: 200,
            }),
          );
          socket.close(1000);
        }
      });
    });
    const provider = providerFor(await server.url());
    const events: TranscriptEvent[] = [];
    const outcome = await runTranscription({
      source: fakeSource(),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async (event) => {
        events.push(event);
      },
    });
    expect(outcome.isOk()).toBe(true);
    if (outcome.isOk()) {
      expect(outcome.value.finals).toBe(0);
      expect(outcome.value.discontinuities).toBeGreaterThan(0);
    }
    expect(events.some((event) => event.type === "discontinuity")).toBe(true);
    expect(events.some((event) => event.type === "final")).toBe(false);
  });

  it("negotiates PCM_16KHZ for 16 kHz input", async () => {
    let handshake = "";
    server = new SpeechTestServer(({ socket }) => {
      socket.once("message", (data: Buffer) => {
        handshake = data.toString();
        socket.send(JSON.stringify({ sessionId: "s" }));
      });
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString().includes("endStream")) {
          socket.close(1000);
        }
      });
    });
    const provider = providerFor(await server.url());
    const outcome = await runTranscription({
      source: fakeSource(2, 16_000),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isOk()).toBe(true);
    expect(handshake).toContain('"audioEncoding":"PCM_16KHZ"');
  });
});

describe("transcription continuity and cleanup", () => {
  function sourceOf(items: SourceItem[]): CaptureSource & { stopSeen: boolean } {
    return trackedSource(items);
  }

  it("rejects a non-contiguous audio sequence", async () => {
    const source = sourceOf([formatItem(), audioItem(1, 0), audioItem(3, 960), endItem(3, 960)]);
    const session = new FakeSpeechSession(async function* () {});
    const provider: SpeechProvider = {
      providerId: "test",
      modelId: "test",
      openSession: async () => ok(session),
    };
    const outcome = await runTranscription({
      source,
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isErr()).toBe(true);
    expect(session.terminated).toBe(true);
  });

  it("rejects a helper delivery count that contradicts received audio", async () => {
    const source = sourceOf([
      formatItem(),
      audioItem(1, 0),
      {
        type: "end",
        seq: 2,
        end: { captured: 5, delivered: 5, dropped: 0, reason: "completed", sourceFrames: 480 },
      },
    ]);
    const session = new FakeSpeechSession(async function* () {});
    const provider: SpeechProvider = {
      providerId: "test",
      modelId: "test",
      openSession: async () => ok(session),
    };
    const outcome = await runTranscription({
      source,
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("emits a tail gap when the helper clock outruns delivered audio", async () => {
    const source = sourceOf([
      formatItem(),
      audioItem(1, 0),
      {
        type: "end",
        seq: 2,
        end: { captured: 1, delivered: 1, dropped: 0, reason: "completed", sourceFrames: 960 },
      },
    ]);
    const session = new FakeSpeechSession(async function* () {});
    const provider: SpeechProvider = {
      providerId: "test",
      modelId: "test",
      openSession: async () => ok(session),
    };
    const events: TranscriptEvent[] = [];
    const outcome = await runTranscription({
      source,
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async (event) => {
        events.push(event);
      },
    });
    expect(outcome.isOk()).toBe(true);
    expect(
      events.some((event) => event.type === "discontinuity" && event.reason === "capture-gap"),
    ).toBe(true);
  });

  it("stops the source when the provider fails", async () => {
    const source = sourceOf([formatItem(), audioItem(1, 0), audioItem(2, 480), endItem(3, 960)]);
    const session = new FakeSpeechSession(async function* () {
      throw appError("INTERNAL", "provider exploded");
    });
    const provider: SpeechProvider = {
      providerId: "test",
      modelId: "test",
      openSession: async () => ok(session),
    };
    const outcome = await runTranscription({
      source,
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isErr()).toBe(true);
    expect(source.stopSeen).toBe(true);
    expect(session.terminated).toBe(true);
  });

  it("cleans up when the output consumer fails", async () => {
    const source = sourceOf([formatItem(), audioItem(1, 0), endItem(2, 480)]);
    const session = new FakeSpeechSession(async function* () {
      yield { type: "completed", turnRef: "1", text: "hi" };
    });
    const provider: SpeechProvider = {
      providerId: "test",
      modelId: "test",
      openSession: async () => ok(session),
    };
    const outcome = await runTranscription({
      source,
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {
        throw appError("INTERNAL", "sink exploded");
      },
    });
    expect(outcome.isErr()).toBe(true);
    expect(source.stopSeen).toBe(true);
    expect(session.terminated).toBe(true);
  });

  it("stops a waiting source promptly when the provider fails", async () => {
    const source = hangingSource();
    const session = new FakeSpeechSession(async function* () {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      throw appError("INTERNAL", "provider exploded");
    });
    const provider: SpeechProvider = {
      providerId: "test",
      modelId: "test",
      openSession: async () => ok(session),
    };
    const started = Date.now();
    const outcome = await runTranscription({
      source,
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("INTERNAL");
    }
    expect(source.stopSeen).toBe(true);
    expect(session.terminated).toBe(true);
  });

  it("cancels promptly during finalization", async () => {
    server = new SpeechTestServer(({ socket }) => {
      acknowledge(socket);
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString().includes("endStream")) {
          setTimeout(() => {
            socket.send(
              JSON.stringify({
                type: "speechComplete",
                turnId: 1,
                transcript: "Late.",
                audioProcessedMs: 100,
              }),
            );
            socket.close(1000);
          }, 300);
        }
      });
    });
    const controller = new AbortController();
    const provider = providerFor(await server.url());
    const outcome = runTranscription({
      source: fakeSource(4),
      provider,
      signal: controller.signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    controller.abort();
    const result = await outcome;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("CANCELLED");
    }
    await server.closed;
    expect(server.connections).toBe(1);
  });

  it("terminates the session when the source fails abnormally", async () => {
    const failing: CaptureSource & { stopSeen: boolean } = {
      ...trackedSource([formatItem()]),
      async *items(): AsyncIterable<SourceItem> {
        yield formatItem();
        throw appError("INTERNAL", "source exploded");
      },
    };
    const session = new FakeSpeechSession(async function* () {});
    const provider: SpeechProvider = {
      providerId: "test",
      modelId: "test",
      openSession: async () => ok(session),
    };
    const outcome = await runTranscription({
      source: failing,
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isErr()).toBe(true);
    expect(session.terminated).toBe(true);
  });

  it("discloses cloud transmission on stderr in JSON mode", async () => {
    const { tmpdir } = await import("node:os");
    tempDir = mkdtempSync(join(tmpdir(), "urbuddy-tx-"));
    const lines: string[] = [];
    const errLines: string[] = [];
    const port = createTranscribePort({
      clock: { now: () => 0, isoNow: () => "" },
      createProvider: () => {
        const session = new FakeSpeechSession(async function* () {});
        return ok({
          providerId: "test",
          modelId: "test",
          openSession: async () => ok(session),
        });
      },
      spawnCapture: () => ok(trackedSource([formatItem(), endItem(1, 0)])),
    });
    const outcome = await port({
      durationMs: 30_000,
      mode: "endpointing",
      keywords: [],
      json: true,
      signal: new AbortController().signal,
      output: {
        out: (line: string) => {
          lines.push(line);
        },
        errLine: (line: string) => {
          errLines.push(line);
        },
      },
      env: {},
    });
    expect(outcome.isOk()).toBe(true);
    expect(errLines.some((line) => line.includes("disclosure"))).toBe(true);
    expect(lines.every((line) => !line.includes("disclosure"))).toBe(true);
  });
});
