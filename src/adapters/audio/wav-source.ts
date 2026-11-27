import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { appError, isAppError, type AppError } from "@kernel/errors";
import type { CaptureSource, SourceItem } from "@modules/perception/audio";
import { err, ok, type Result } from "neverthrow";

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
}

export interface OpenWavOptions {
  readonly chunkFrames?: number;
  readonly smokeFixtureOnly?: boolean;
  readonly pacing?: "realtime" | "none";
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CHUNK_FRAMES = 1_920;
const MAX_CHUNK_FRAMES = 96_000;
const HEADER_SCAN_BOUND = 1_048_576;
const READ_BLOCK = 65_536;
const SMOKE_PCM_BYTES = 96_000;
const SMOKE_PCM_SHA256 = "f2a7976c8cf240b27df7b8201ae31040a67b319479d25073c83c8d786f1e3a28";

interface LocatedWav {
  readonly info: WavInfo;
  readonly dataOffset: number;
  readonly dataBytes: number;
}

async function readAt(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<{ bytes: Buffer; eof: boolean }> {
  const buffer = Buffer.alloc(length);
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return { bytes: buffer.subarray(0, bytesRead), eof: bytesRead < length };
  } catch (thrown: unknown) {
    const code = (thrown as { code?: unknown }).code;
    if (code === "EAGAIN") {
      throw appError("VALIDATION_FAILED", "WAV input is not readable without blocking");
    }
    throw thrown;
  }
}

async function locateWav(
  handle: FileHandle,
  fileSize: number,
): Promise<Result<LocatedWav, AppError>> {
  let buffered = Buffer.alloc(0);
  let fileOffset = 0;
  const fill = async (needed: number): Promise<Result<Buffer, AppError>> => {
    while (buffered.length < needed) {
      if (fileOffset >= fileSize) {
        return err(appError("VALIDATION_FAILED", "WAV input ends before its chunks are complete"));
      }
      if (fileOffset >= HEADER_SCAN_BOUND) {
        return err(appError("VALIDATION_FAILED", "WAV header exceeds the size bound"));
      }
      const block = await readAt(
        handle,
        Math.min(READ_BLOCK, HEADER_SCAN_BOUND - fileOffset, fileSize - fileOffset),
        fileOffset,
      );
      if (block.bytes.length === 0) {
        return err(appError("VALIDATION_FAILED", "WAV input ends before its chunks are complete"));
      }
      buffered = Buffer.concat([buffered, block.bytes]);
      fileOffset += block.bytes.length;
    }
    return ok(buffered);
  };
  const header = await fill(12);
  if (header.isErr()) {
    return err(header.error);
  }
  let view = header.value;
  if (
    view.length < 12 ||
    view.toString("ascii", 0, 4) !== "RIFF" ||
    view.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return err(appError("VALIDATION_FAILED", "WAV input is not a RIFF/WAVE file"));
  }
  const riffSize = view.readUInt32LE(4);
  const riffSane = riffSize !== 0 && riffSize !== 0xff_ff_ff_ff;
  let offset = 12;
  let format:
    { sampleRate: number; channels: number; bits: number; audioFormat: number } | undefined;
  for (;;) {
    const chunkHead = await fill(offset + 8);
    if (chunkHead.isErr()) {
      return err(chunkHead.error);
    }
    view = chunkHead.value;
    const id = view.toString("ascii", offset, offset + 4);
    const size = view.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16) {
        return err(appError("VALIDATION_FAILED", "WAV format chunk is truncated"));
      }
      const bodyFull = await fill(body + 16);
      if (bodyFull.isErr()) {
        return err(bodyFull.error);
      }
      view = bodyFull.value;
      format = {
        audioFormat: view.readUInt16LE(body),
        channels: view.readUInt16LE(body + 2),
        sampleRate: view.readUInt32LE(body + 4),
        bits: view.readUInt16LE(body + 14),
      };
      offset = body + size + (size % 2);
      continue;
    }
    if (id === "data") {
      if (format === undefined) {
        return err(appError("VALIDATION_FAILED", "WAV input is missing its format chunk"));
      }
      if (format.audioFormat !== 1 || format.bits !== 16) {
        return err(appError("UNSUPPORTED", "WAV input must be 16-bit integer PCM"));
      }
      if (format.channels < 1 || format.channels > 2 || format.sampleRate <= 0) {
        return err(appError("UNSUPPORTED", "WAV input must be mono or stereo at a positive rate"));
      }
      if (body + size > fileSize) {
        return err(appError("VALIDATION_FAILED", "WAV data chunk extends beyond the file"));
      }
      if (riffSane && body + size > 8 + riffSize) {
        return err(appError("VALIDATION_FAILED", "WAV data chunk extends beyond its container"));
      }
      const bytesPerFrame = format.channels * 2;
      if (size % bytesPerFrame !== 0) {
        return err(appError("VALIDATION_FAILED", "WAV data chunk is not frame aligned"));
      }
      return ok({
        info: {
          sampleRate: format.sampleRate,
          channels: format.channels,
          frames: size / bytesPerFrame,
        },
        dataOffset: body,
        dataBytes: size,
      });
    }
    offset = body + size + (size % 2);
  }
}

class WavCaptureSource implements CaptureSource {
  private stopped = false;

  constructor(
    private readonly handle: FileHandle,
    private readonly info: WavInfo,
    private readonly dataOffset: number,
    private readonly dataBytes: number,
    private readonly options: OpenWavOptions,
    private readonly verifiedPcm?: Buffer,
  ) {}

  async *items(signal: AbortSignal): AsyncIterable<SourceItem> {
    const chunkFrames = this.options.chunkFrames ?? DEFAULT_CHUNK_FRAMES;
    const bytesPerFrame = this.info.channels * 2;
    let seq = 0;
    yield {
      type: "format",
      seq: 0,
      format: { sampleRate: this.info.sampleRate, channels: this.info.channels },
    };
    let framesRead = 0;
    let position = this.dataOffset;
    const endOfData = this.dataOffset + this.dataBytes;
    const startedAt = Date.now();
    let lastYieldAt = startedAt;
    while (framesRead < this.info.frames) {
      if (signal.aborted || this.stopped) {
        break;
      }
      const wanted = Math.min(chunkFrames, this.info.frames - framesRead);
      const bytes =
        this.verifiedPcm === undefined
          ? (await readAt(this.handle, wanted * bytesPerFrame, position)).bytes
          : this.verifiedPcm.subarray(
              position - this.dataOffset,
              position - this.dataOffset + wanted * bytesPerFrame,
            );
      if (bytes.length === 0) {
        throw appError("VALIDATION_FAILED", "WAV data ended before its declared extent");
      }
      const completeFrames = Math.floor(bytes.length / bytesPerFrame);
      const samples = new Float32Array(completeFrames * this.info.channels);
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = bytes.readInt16LE(i * 2) / 32_768;
      }
      seq += 1;
      yield {
        type: "audio",
        chunk: { seq, startSample: framesRead, samples },
      };
      framesRead += completeFrames;
      position += completeFrames * bytesPerFrame;
      if ((this.options.pacing ?? "realtime") === "realtime" && framesRead < this.info.frames) {
        const sleep =
          this.options.sleep ??
          ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        const audioMs = (framesRead / this.info.sampleRate) * 1000;
        const waitMs = audioMs - (Date.now() - startedAt);
        if (waitMs > 0) {
          await sleep(waitMs);
        }
        const chunkMs = (completeFrames / this.info.sampleRate) * 1000;
        const sinceYield = Date.now() - lastYieldAt;
        const minInterval = chunkMs / 2;
        if (sinceYield < minInterval) {
          await sleep(minInterval - sinceYield);
        }
        lastYieldAt = Date.now();
      }
      if (position >= endOfData) {
        break;
      }
    }
    if (framesRead < this.info.frames && !signal.aborted && !this.stopped) {
      throw appError("VALIDATION_FAILED", "WAV data ended before its declared extent");
    }
    seq += 1;
    yield {
      type: "end",
      seq,
      end: {
        captured: framesRead,
        delivered: seq - 1,
        dropped: 0,
        reason: signal.aborted || this.stopped ? "cancelled" : "completed",
        sourceFrames: this.info.frames,
      },
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async dispose(): Promise<Result<void, AppError>> {
    try {
      await this.handle.close();
      return ok(undefined);
    } catch {
      return err(appError("RESOURCE_RELEASE_FAILED", "WAV input cleanup failed"));
    }
  }
}

export async function openWavSource(
  path: string,
  options: OpenWavOptions = {},
): Promise<Result<CaptureSource & { readonly info: WavInfo }, AppError>> {
  const chunkFrames = options.chunkFrames ?? DEFAULT_CHUNK_FRAMES;
  if (!Number.isInteger(chunkFrames) || chunkFrames < 1 || chunkFrames > MAX_CHUNK_FRAMES) {
    return err(appError("VALIDATION_FAILED", "WAV chunk size is out of range"));
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return err(appError("RESOURCE_ACQUIRE_FAILED", "WAV input could not be opened"));
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close().catch(() => undefined);
      return err(appError("VALIDATION_FAILED", "WAV input must be a regular file"));
    }
    const located = await locateWav(handle, stat.size);
    if (located.isErr()) {
      await handle.close().catch(() => undefined);
      return err(located.error);
    }
    let verifiedPcm: Buffer | undefined;
    if (options.smokeFixtureOnly) {
      const { info, dataOffset, dataBytes } = located.value;
      if (info.sampleRate === 24_000 && info.channels === 1 && dataBytes === SMOKE_PCM_BYTES) {
        const { bytes } = await readAt(handle, SMOKE_PCM_BYTES, dataOffset);
        if (createHash("sha256").update(bytes).digest("hex") === SMOKE_PCM_SHA256) {
          verifiedPcm = bytes;
        }
      }
      if (verifiedPcm === undefined) {
        await handle.close();
        return err(
          appError("VALIDATION_FAILED", "bilingual loopback requires the synthetic smoke WAV"),
        );
      }
    }
    const source = new WavCaptureSource(
      handle,
      located.value.info,
      located.value.dataOffset,
      located.value.dataBytes,
      { ...options, chunkFrames },
      verifiedPcm,
    );
    return ok(Object.assign(source, { info: located.value.info }));
  } catch (thrown: unknown) {
    await handle.close().catch(() => undefined);
    if (isAppError(thrown)) {
      return err(thrown);
    }
    return err(appError("RESOURCE_ACQUIRE_FAILED", "WAV input could not be read"));
  }
}
