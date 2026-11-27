import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWavSource } from "@adapters/audio/wav-source";
import { createMuseProvider, resolveMuseEndpoint } from "@adapters/speech/muse";
import type { CaptureSource, SourceItem } from "@modules/perception/audio";
import { runTranscription, type TranscriptEvent } from "@modules/perception/speech";
import { createTranscribePort } from "@presentation/transcribe";
import { ok } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

interface ServerScript {
  onConnection(socket: WebSocket, index: number, server: TestServer): void;
}

class TestServer {
  readonly sockets: WebSocket[] = [];
  readonly receivedAudio: Buffer[] = [];
  readonly receivedText: string[] = [];
  connections = 0;
  private readonly wss: WebSocketServer;
  private listening: Promise<void>;

  constructor(private readonly script: ServerScript) {
    this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    this.listening = new Promise<void>((resolve) => this.wss.once("listening", resolve));
    this.wss.on("connection", (socket) => {
      const index = this.connections;
      this.connections += 1;
      this.sockets.push(socket);
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          this.receivedAudio.push(Buffer.from(data));
        } else {
          this.receivedText.push(data.toString());
        }
      });
      this.script.onConnection(socket, index, this);
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

let server: TestServer | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function fakeSource(frames = 4): CaptureSource {
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
  return {
    async *items(): AsyncIterable<SourceItem> {
      for (const item of items) {
        yield item;
      }
    },
    async stop(): Promise<void> {},
    async dispose() {
      return ok(undefined);
    },
  };
}

function pacedSource(frames: number, gapMs: number): CaptureSource {
  const base = fakeSource(frames);
  return {
    async *items(signal: AbortSignal): AsyncIterable<SourceItem> {
      for await (const item of base.items(signal)) {
        yield item;
        if (item.type === "audio") {
          await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
        }
      }
    },
    async stop(): Promise<void> {
      await base.stop();
    },
    async dispose() {
      return base.dispose();
    },
  };
}

function ack(socket: WebSocket): void {
  socket.once("message", (_data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      socket.send(JSON.stringify({ sessionId: "test-session-1" }));
    }
  });
}

function happyScript(extra?: (socket: WebSocket) => void): ServerScript {
  return {
    onConnection(socket) {
      ack(socket);
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString().includes("endStream")) {
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
            JSON.stringify({
              type: "transcript",
              transcript: "hello world",
              final: false,
              audioProcessedMs: 300,
            }),
          );
          socket.send(JSON.stringify({ type: "speechEnd", turnId: 1, audioProcessedMs: 400 }));
          socket.send(
            JSON.stringify({
              type: "speechComplete",
              turnId: 1,
              transcript: "Hello world.",
              audioProcessedMs: 400,
            }),
          );
          extra?.(socket);
          socket.close(1000);
        }
      });
    },
  };
}

describe("Muse transport (local server)", () => {
  it("waits for the handshake ack, sends binary audio, and surfaces finals", async () => {
    server = new TestServer(happyScript());
    const provider = createMuseProvider({
      apiKey: "test-key",
      testLoopbackEndpoint: await server.url(),
      reconnectBackoffMs: [10],
    });
    const events: TranscriptEvent[] = [];
    const outcome = await runTranscription({
      source: fakeSource(),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: ["idempotency"],
      onEvent: async (event) => {
        events.push(event);
      },
    });
    expect(outcome.isOk()).toBe(true);
    if (outcome.isOk()) {
      expect(outcome.value.finals).toBe(1);
      expect(outcome.value.modelId).toBe("muse-voice-transcribe-1.0");
      expect(outcome.value.providerSessionId).toBe("test-session-1");
    }
    expect(events.some((e) => e.type === "final" && e.text === "Hello world.")).toBe(true);
    expect(server.receivedText[0]).toContain("authorization");
    expect(server.receivedText[0]).toContain("idempotency");
    expect(server.receivedAudio.length).toBeGreaterThan(0);
    expect(server.receivedAudio.every((chunk) => chunk.length % 2 === 0)).toBe(true);
  });

  it("rejects a malformed handshake without sending audio", async () => {
    server = new TestServer({
      onConnection(socket) {
        socket.once("message", () => socket.send(JSON.stringify({ nope: true })));
      },
    });
    const provider = createMuseProvider({
      apiKey: "test-key",
      testLoopbackEndpoint: await server.url(),
    });
    const opened = await provider.openSession({
      mode: "endpointing",
      encoding: "PCM_24KHZ",
      keywords: [],
      signal: new AbortController().signal,
    });
    expect(opened.isErr()).toBe(true);
    expect(server.receivedAudio.length).toBe(0);
  });

  it("does not retry a protocol rejection", async () => {
    server = new TestServer({
      onConnection(socket) {
        socket.once("message", () => socket.close(1008));
      },
    });
    const provider = createMuseProvider({
      apiKey: "bad-key",
      testLoopbackEndpoint: await server.url(),
      reconnectBackoffMs: [10],
    });
    const opened = await provider.openSession({
      mode: "endpointing",
      encoding: "PCM_24KHZ",
      keywords: [],
      signal: new AbortController().signal,
    });
    expect(opened.isErr()).toBe(true);
    expect(server.connections).toBe(1);
  });

  it("fails closed on a conflicting duplicate completion", async () => {
    server = new TestServer(
      happyScript((socket) => {
        socket.send(
          JSON.stringify({
            type: "speechComplete",
            turnId: 1,
            transcript: "Different.",
            audioProcessedMs: 500,
          }),
        );
      }),
    );
    const provider = createMuseProvider({
      apiKey: "test-key",
      testLoopbackEndpoint: await server.url(),
    });
    const outcome = await runTranscription({
      source: fakeSource(),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("rejects oversized provider messages", async () => {
    server = new TestServer({
      onConnection(socket) {
        ack(socket);
        socket.on("message", (data: Buffer, isBinary: boolean) => {
          if (!isBinary && data.toString().includes("endStream")) {
            socket.send(
              JSON.stringify({
                type: "transcript",
                transcript: "x".repeat(100_000),
                final: false,
                audioProcessedMs: 1,
              }),
            );
          }
        });
      },
    });
    const provider = createMuseProvider({
      apiKey: "test-key",
      testLoopbackEndpoint: await server.url(),
    });
    const outcome = await runTranscription({
      source: fakeSource(),
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("reconnects once after a transient drop and marks the new epoch", async () => {
    server = new TestServer({
      onConnection(socket, index) {
        ack(socket);
        if (index === 0) {
          socket.on("message", (_data: Buffer, isBinary: boolean) => {
            if (isBinary) {
              socket.close(1011);
            }
          });
          return;
        }
        socket.on("message", (data: Buffer, isBinary: boolean) => {
          if (!isBinary && data.toString().includes("endStream")) {
            socket.send(
              JSON.stringify({
                type: "speechComplete",
                turnId: 1,
                transcript: "Recovered.",
                audioProcessedMs: 100,
              }),
            );
            socket.close(1000);
          }
        });
      },
    });
    const provider = createMuseProvider({
      apiKey: "test-key",
      testLoopbackEndpoint: await server.url(),
      reconnectBackoffMs: [10],
      maxReconnects: 2,
    });
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
    expect(server.connections).toBe(2);
    expect(events.some((e) => e.type === "discontinuity")).toBe(true);
    expect(outcome.isOk() ? outcome.value.finals : -1).toBe(1);
  });

  it("requires a credential before connecting", async () => {
    server = new TestServer(happyScript());
    const provider = createMuseProvider({ apiKey: "  ", testLoopbackEndpoint: await server.url() });
    const opened = await provider.openSession({
      mode: "endpointing",
      encoding: "PCM_24KHZ",
      keywords: [],
      signal: new AbortController().signal,
    });
    expect(opened.isErr()).toBe(true);
    expect(server.connections).toBe(0);
  });

  it("denies transcription without egress wiring and never connects", async () => {
    server = new TestServer(happyScript());
    const port = createTranscribePort({ clock: { now: () => 0, isoNow: () => "" } });
    const outcome = await port({
      file: "input.wav",
      mode: "endpointing",
      keywords: [],
      json: false,
      signal: new AbortController().signal,
      output: { out: () => {}, errLine: () => {} },
      env: {},
    });
    expect(outcome.isErr()).toBe(true);
    expect(server.connections).toBe(0);
  });
});

describe("resolveMuseEndpoint", () => {
  it("uses the production endpoint by default", () => {
    for (const raw of [undefined, "", "   "] as const) {
      const resolved = resolveMuseEndpoint(raw);
      expect(resolved.isOk()).toBe(true);
      if (resolved.isOk()) {
        expect(resolved.value).toBe("wss://api.meta.ai/v1/asr/realtime");
      }
    }
  });

  it("accepts loopback overrides for local smoke servers", () => {
    const loopback = resolveMuseEndpoint("ws://127.0.0.1:18923");
    expect(loopback.isOk()).toBe(true);
    const local = resolveMuseEndpoint("ws://localhost:18923");
    expect(local.isOk()).toBe(true);
    const secure = resolveMuseEndpoint("wss://127.0.0.1:1");
    expect(secure.isOk()).toBe(true);
    if (secure.isOk()) {
      expect(secure.value).toContain("127.0.0.1");
    }
  });

  it("rejects remote and malformed endpoints before any connection", () => {
    for (const raw of [
      "wss://evil.example.com/asr",
      "ws://evil.example.com/asr",
      "https://api.meta.ai/v1/asr/realtime",
      "::not-a-url::",
    ]) {
      const resolved = resolveMuseEndpoint(raw);
      expect(resolved.isErr()).toBe(true);
      if (resolved.isErr()) {
        expect(resolved.error.code).toBe("VALIDATION_FAILED");
      }
    }
  });
});

describe("WAV source", () => {
  function writeWav(extraChunk: boolean): string {
    tempDir = mkdtempSync(join(tmpdir(), "urbuddy-wav-"));
    const path = join(tempDir, "input.wav");
    const frames = 2400;
    const dataBytes = frames * 2;
    const chunks: Buffer[] = [];
    const fmt = Buffer.alloc(24);
    fmt.write("fmt ", 0);
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(24_000, 12);
    fmt.writeUInt32LE(48_000, 16);
    fmt.writeUInt16LE(2, 20);
    fmt.writeUInt16LE(16, 22);
    chunks.push(fmt);
    if (extraChunk) {
      const junk = Buffer.alloc(8 + 5);
      junk.write("JUNK", 0);
      junk.writeUInt32LE(5, 4);
      junk.write("abcde", 8);
      const padded = Buffer.concat([junk, Buffer.alloc(1)]);
      chunks.push(padded);
    }
    const dataHeader = Buffer.alloc(8);
    dataHeader.write("data", 0);
    dataHeader.writeUInt32LE(dataBytes, 4);
    chunks.push(dataHeader);
    const pcm = Buffer.alloc(dataBytes);
    for (let i = 0; i < frames; i += 1) {
      pcm.writeInt16LE(
        Math.round(0.25 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 24_000)),
        i * 2,
      );
    }
    chunks.push(pcm);
    const body = Buffer.concat(chunks);
    const riff = Buffer.alloc(8);
    riff.write("RIFF", 0);
    riff.writeUInt32LE(4 + body.length, 4);
    writeFileSync(path, Buffer.concat([riff, Buffer.from("WAVE"), body]));
    return path;
  }

  it("parses chunk boundaries instead of assuming a fixed header", async () => {
    const path = writeWav(true);
    const opened = await openWavSource(path, { pacing: "none" });
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) return;
    expect(opened.value.info.frames).toBe(2400);
    const items: SourceItem[] = [];
    for await (const item of opened.value.items(new AbortController().signal)) {
      items.push(item);
    }
    expect(items[0]?.type).toBe("format");
    expect(items.some((item) => item.type === "audio")).toBe(true);
    expect(items.at(-1)?.type).toBe("end");
    await opened.value.dispose();
  });

  it("rejects non-PCM WAV input", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "urbuddy-wav-"));
    const path = join(tempDir, "bad.wav");
    writeFileSync(path, Buffer.from("RIFFxxxxWAVEfmt not-a-real-format-chunk"));
    const opened = await openWavSource(path, { pacing: "none" });
    expect(opened.isErr()).toBe(true);
  });
});
