import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FrameDecoder } from "@adapters/audio/capture-source";
import { isAppError } from "@kernel/errors";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, "..", "fixtures", "audio", "synthetic-5x256.bin");

function header(
  kind: number,
  seq: bigint,
  payloadLen: number,
  magic = 0x55424431,
  version = 1,
): Buffer {
  const out = Buffer.alloc(20);
  out.writeUInt32LE(magic, 0);
  out.writeUInt16LE(kind, 4);
  out.writeUInt16LE(version, 6);
  out.writeBigUInt64LE(seq, 8);
  out.writeUInt32LE(payloadLen, 16);
  return out;
}

function formatPayload(sampleRate = 48000, channels = 2, tag = 1): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeUInt32LE(sampleRate, 0);
  payload.writeUInt16LE(channels, 4);
  payload.writeUInt16LE(tag, 6);
  return payload;
}

function audioPayload(startSample: bigint, samples: number): Buffer {
  const payload = Buffer.alloc(8 + samples * 4);
  payload.writeBigUInt64LE(startSample, 0);
  for (let i = 0; i < samples; i += 1) {
    payload.writeFloatLE(0.25, 8 + i * 4);
  }
  return payload;
}

function endPayload(captured = 1n, delivered = 1n, dropped = 0n, reason = 0): Buffer {
  const payload = Buffer.alloc(26);
  payload.writeBigUInt64LE(captured, 0);
  payload.writeBigUInt64LE(delivered, 8);
  payload.writeBigUInt64LE(dropped, 16);
  payload.writeUInt16LE(reason, 24);
  return payload;
}

function expectFailure(data: Buffer, code: string): void {
  const decoder = new FrameDecoder();
  let failure: unknown;
  try {
    decoder.push(data);
  } catch (thrown: unknown) {
    failure = thrown;
  }
  expect(isAppError(failure)).toBe(true);
  expect((failure as { code: string }).code).toBe(code);
}

describe("audio frame decoding", () => {
  it("decodes the cross-language golden fixture produced by the Swift helper", () => {
    const bytes = readFileSync(goldenPath);
    const decoder = new FrameDecoder();
    const items = decoder.push(bytes);
    expect(items).toHaveLength(7);
    const first = items[0];
    expect(first?.type).toBe("format");
    if (first?.type !== "format") {
      throw new Error("golden fixture must start with a format frame");
    }
    expect(first.seq).toBe(0);
    expect(first.format).toEqual({ sampleRate: 48000, channels: 2 });
    for (let n = 1; n <= 5; n += 1) {
      const item = items[n];
      expect(item?.type).toBe("audio");
      if (item?.type !== "audio") {
        throw new Error("golden fixture must carry five audio frames");
      }
      expect(item.chunk.seq).toBe(n);
      expect(item.chunk.startSample).toBe((n - 1) * 256);
      expect(item.chunk.samples).toHaveLength(256 * 2);
    }
    const second = items[1];
    if (second?.type !== "audio") {
      throw new Error("golden fixture must carry audio content");
    }
    expect(second.chunk.samples[0]).toBe(0);
    expect(second.chunk.samples[1]).toBe(0);
    expect(second.chunk.samples[2]).toBeCloseTo(0.5 * Math.sin((2 * Math.PI * 440) / 48000), 5);
    const last = items[6];
    expect(last).toEqual({
      type: "end",
      seq: 6,
      end: { captured: 5, delivered: 5, dropped: 0, reason: "completed" },
    });
  });

  it("reassembles headers split across reads", () => {
    const payload = formatPayload();
    const frame = Buffer.concat([header(0, 0n, 8), payload]);
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 7))).toEqual([]);
    expect(decoder.push(frame.subarray(7, 19))).toEqual([]);
    const items = decoder.push(frame.subarray(19));
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("format");
  });

  it("decodes coalesced frames from one read", () => {
    const audio = audioPayload(0n, 8);
    const end = endPayload();
    const decoder = new FrameDecoder();
    const items = decoder.push(
      Buffer.concat([header(1, 1n, audio.byteLength), audio, header(2, 2n, 26), end]),
    );
    expect(items.map((item) => item.type)).toEqual(["audio", "end"]);
  });

  it("waits for a truncated payload instead of failing", () => {
    const audio = audioPayload(0n, 8);
    const frame = Buffer.concat([header(1, 3n, audio.byteLength), audio]);
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 30))).toEqual([]);
    const items = decoder.push(frame.subarray(30));
    expect(items).toHaveLength(1);
    if (items[0]?.type !== "audio") {
      throw new Error("truncated frame must decode after its remainder arrives");
    }
    expect(items[0].chunk.seq).toBe(3);
  });

  it("rejects an unrecognized frame without consuming input", () => {
    const bad = Buffer.concat([header(1, 1n, 40, 0xdeadbeef), Buffer.alloc(40)]);
    expectFailure(bad, "VALIDATION_FAILED");
  });

  it("rejects an unknown frame kind", () => {
    const bad = Buffer.concat([header(9, 1n, 0), Buffer.alloc(0)]);
    expectFailure(bad, "VALIDATION_FAILED");
  });

  it("rejects an unsupported protocol version", () => {
    const payload = formatPayload();
    const bad = Buffer.concat([header(0, 0n, 8, 0x55424431, 2), payload]);
    expectFailure(bad, "VALIDATION_FAILED");
  });

  it("refuses an oversized payload before allocating", () => {
    const bad = header(1, 1n, 2_097_152);
    expectFailure(bad, "VALIDATION_FAILED");
  });

  it("rejects a misaligned audio payload", () => {
    const bad = Buffer.concat([header(1, 1n, 10), Buffer.alloc(10)]);
    expectFailure(bad, "VALIDATION_FAILED");
  });

  it("rejects a mis-sized format payload", () => {
    const bad = Buffer.concat([header(0, 0n, 4), Buffer.alloc(4)]);
    expectFailure(bad, "VALIDATION_FAILED");
  });

  it("rejects an unsupported audio encoding tag", () => {
    const bad = Buffer.concat([header(0, 0n, 8), formatPayload(48000, 2, 2)]);
    expectFailure(bad, "VALIDATION_FAILED");
  });

  it("rejects a sequence counter beyond the safe integer range", () => {
    const bad = header(1, 2n ** 60n, 0);
    expectFailure(bad, "VALIDATION_FAILED");
  });
});
