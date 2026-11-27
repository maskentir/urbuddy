import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWavSource } from "@adapters/audio/wav-source";
import type { AppError } from "@kernel/errors";
import type { CaptureSource, SourceItem } from "@modules/perception/audio";
import {
  runTranscription,
  type SpeechProvider,
  type SpeechProviderEvent,
  type SpeechSession,
} from "@modules/perception/speech";
import { ok, type Result } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";

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

  async endInput(): Promise<Result<void, AppError>> {
    this.endInputSeen = true;
    return ok(undefined);
  }

  async terminate(): Promise<Result<void, AppError>> {
    this.terminated = true;
    return ok(undefined);
  }
}

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function makeDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "urbuddy-wav-"));
  return tempDir;
}

function writeWav(
  path: string,
  frames: number,
  sampleRate = 24_000,
  channels = 1,
  frequency = 440,
): void {
  const dataBytes = frames * channels * 2;
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * 2, 16);
  fmt.writeUInt16LE(channels * 2, 20);
  fmt.writeUInt16LE(16, 22);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0);
  dataHeader.writeUInt32LE(dataBytes, 4);
  const pcm = Buffer.alloc(dataBytes);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(0.3 * 32_767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
    for (let c = 0; c < channels; c += 1) {
      pcm.writeInt16LE(sample, (i * channels + c) * 2);
    }
  }
  const body = Buffer.concat([fmt, dataHeader, pcm]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(4 + body.length, 4);
  writeFileSync(path, Buffer.concat([riff, Buffer.from("WAVE"), body]));
}

function countingProvider(events: SpeechProvider["openSession"]): SpeechProvider {
  return {
    providerId: "test",
    modelId: "test",
    openSession: events,
  };
}

describe("WAV source extent", () => {
  it("consumes a valid WAV larger than 1 MiB completely", async () => {
    const dir = makeDir();
    const path = join(dir, "large.wav");
    const frames = 32 * 24_000;
    writeWav(path, frames);
    const opened = await openWavSource(path, { pacing: "none" });
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) {
      return;
    }
    expect(opened.value.info.frames).toBe(frames);
    let audioItems = 0;
    let endSeq = 0;
    for await (const item of opened.value.items(new AbortController().signal)) {
      if (item.type === "audio") {
        audioItems += 1;
      }
      if (item.type === "end") {
        endSeq = item.seq;
        expect(item.end.sourceFrames).toBe(frames);
        expect(item.end.captured).toBe(frames);
      }
    }
    expect(audioItems).toBe(Math.ceil(frames / 1_920));
    expect(endSeq).toBe(audioItems + 1);
    await opened.value.dispose();
  });

  it("reports exact transmitted bytes through the transcription operation", async () => {
    const dir = makeDir();
    const path = join(dir, "large.wav");
    const frames = 4 * 24_000;
    writeWav(path, frames);
    const opened = await openWavSource(path, { pacing: "none" });
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) {
      return;
    }
    let sentBytes = 0;
    const session = new FakeSpeechSession(async function* () {});
    const provider = countingProvider(async () => {
      const inner = session.sendAudio.bind(session);
      session.sendAudio = async (pcm) => {
        sentBytes += pcm.length;
        return inner(pcm);
      };
      return ok(session);
    });
    const outcome = await runTranscription({
      source: opened.value,
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isOk()).toBe(true);
    if (outcome.isOk()) {
      expect(outcome.value.inputFrames).toBe(frames);
      expect(outcome.value.outputFrames).toBe(frames);
      expect(sentBytes).toBe(frames * 2);
    }
  });

  it("rejects a declared data extent beyond the file", async () => {
    const dir = makeDir();
    const path = join(dir, "lying.wav");
    writeWav(path, 2_400);
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(path);
    const dataAt = bytes.indexOf(Buffer.from("data"));
    bytes.writeUInt32LE(100_000_000, dataAt + 4);
    writeFileSync(path, bytes);
    const opened = await openWavSource(path, { pacing: "none" });
    expect(opened.isErr()).toBe(true);
  });

  it("rejects a RIFF container smaller than its data extent", async () => {
    const dir = makeDir();
    const path = join(dir, "riff.wav");
    writeWav(path, 2_400);
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(path);
    bytes.writeUInt32LE(100, 4);
    writeFileSync(path, bytes);
    const opened = await openWavSource(path, { pacing: "none" });
    expect(opened.isErr()).toBe(true);
  });

  it("rejects a data chunk that is not frame aligned", async () => {
    const dir = makeDir();
    const path = join(dir, "odd.wav");
    writeWav(path, 2_400);
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(path);
    const dataAt = bytes.indexOf(Buffer.from("data"));
    bytes.writeUInt32LE(4_799, dataAt + 4);
    writeFileSync(path, bytes.subarray(0, dataAt + 8 + 4_799));
    const opened = await openWavSource(path, { pacing: "none" });
    expect(opened.isErr()).toBe(true);
  });

  it("fails closed when the file shrinks after acquisition", async () => {
    const dir = makeDir();
    const path = join(dir, "cut.wav");
    writeWav(path, 24_000);
    const opened = await openWavSource(path, { pacing: "none" });
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) {
      return;
    }
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, bytes.length - 1_000));
    const session = new FakeSpeechSession(async function* () {});
    const provider = countingProvider(async () => ok(session));
    const outcome = await runTranscription({
      source: opened.value,
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isErr()).toBe(true);
    await opened.value.dispose().catch(() => undefined);
  });

  it("rejects a FIFO without a writer without blocking", async () => {
    let fifo: string;
    try {
      const dir = makeDir();
      fifo = join(dir, "input.wav");
      execFileSync("mkfifo", [fifo]);
    } catch {
      return;
    }
    const started = Date.now();
    const opened = await openWavSource(fifo, { pacing: "none" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(opened.isErr()).toBe(true);
  });

  it("paces realtime output with a minimum inter-chunk interval", async () => {
    const dir = makeDir();
    const path = join(dir, "paced.wav");
    writeWav(path, 3 * 1_920);
    const opened = await openWavSource(path, { pacing: "realtime", sleep: async () => {} });
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) {
      return;
    }
    const sleeps: number[] = [];
    const reopened = await openWavSource(path, {
      pacing: "realtime",
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(reopened.isOk()).toBe(true);
    if (reopened.isErr()) {
      return;
    }
    let drained = 0;
    for await (const item of reopened.value.items(new AbortController().signal)) {
      drained += item.type === "audio" ? 1 : 0;
    }
    expect(drained).toBe(3);
    expect(sleeps.some((ms) => ms >= 40)).toBe(true);
    await opened.value.dispose();
    await reopened.value.dispose();
  });
});

describe("WAV source against the owner corpus", () => {
  const corpus = "evaluation/speech/corpus/multi-speaker-conversation-001.wav";

  it("reads the full 4,471,552-frame corpus offline without egress", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(corpus)) {
      return;
    }
    const opened = await openWavSource(corpus, { pacing: "none" });
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) {
      return;
    }
    expect(opened.value.info).toEqual({ sampleRate: 24_000, channels: 1, frames: 4_471_552 });
    const session = new FakeSpeechSession(async function* () {});
    let sentBytes = 0;
    const inner = session.sendAudio.bind(session);
    session.sendAudio = async (pcm) => {
      sentBytes += pcm.length;
      return inner(pcm);
    };
    const provider = countingProvider(async () => ok(session));
    const outcome = await runTranscription({
      source: opened.value,
      provider,
      signal: new AbortController().signal,
      mode: "endpointing",
      keywords: [],
      onEvent: async () => {},
    });
    expect(outcome.isOk()).toBe(true);
    if (outcome.isOk()) {
      expect(outcome.value.inputFrames).toBe(4_471_552);
      expect(sentBytes).toBe(4_471_552 * 2);
    }
  });
});
