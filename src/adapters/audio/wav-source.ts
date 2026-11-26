import { open, type FileHandle } from "node:fs/promises";

import { appError, type AppError } from "@kernel/errors";
import type { CaptureSource, SourceItem } from "@modules/perception/audio";
import { err, ok, type Result } from "neverthrow";

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
}

export interface OpenWavOptions {
  readonly chunkFrames?: number;
  readonly pacing?: "realtime" | "none";
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CHUNK_FRAMES = 1_920;

function parseWavHeader(
  buffer: Buffer,
): Result<{ info: WavInfo; dataOffset: number; dataBytes: number }, AppError> {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return err(appError("VALIDATION_FAILED", "WAV input is not a RIFF/WAVE file"));
  }
  let offset = 12;
  let format:
    { sampleRate: number; channels: number; bits: number; audioFormat: number } | undefined;
  let dataOffset = -1;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length && id !== "data") {
      return err(appError("VALIDATION_FAILED", "WAV chunk extends beyond the file"));
    }
    if (id === "fmt ") {
      if (size < 16) {
        return err(appError("VALIDATION_FAILED", "WAV format chunk is truncated"));
      }
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = Math.min(size, buffer.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (format === undefined || dataOffset < 0) {
    return err(appError("VALIDATION_FAILED", "WAV input is missing format or data chunks"));
  }
  if (format.audioFormat !== 1 || format.bits !== 16) {
    return err(appError("UNSUPPORTED", "WAV input must be 16-bit integer PCM"));
  }
  if (format.channels < 1 || format.channels > 2 || format.sampleRate <= 0) {
    return err(appError("UNSUPPORTED", "WAV input must be mono or stereo at a positive rate"));
  }
  const bytesPerFrame = format.channels * 2;
  if (dataBytes % bytesPerFrame !== 0) {
    return err(appError("VALIDATION_FAILED", "WAV data chunk is not frame aligned"));
  }
  return ok({
    info: {
      sampleRate: format.sampleRate,
      channels: format.channels,
      frames: dataBytes / bytesPerFrame,
    },
    dataOffset,
    dataBytes,
  });
}

class WavCaptureSource implements CaptureSource {
  private stopped = false;

  constructor(
    private readonly handle: FileHandle,
    private readonly info: WavInfo,
    private readonly dataOffset: number,
    private readonly dataBytes: number,
    private readonly options: OpenWavOptions,
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
    while (framesRead < this.info.frames) {
      if (signal.aborted || this.stopped) {
        break;
      }
      const wanted = Math.min(chunkFrames, this.info.frames - framesRead);
      const buffer = Buffer.alloc(wanted * bytesPerFrame);
      const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      const completeFrames = Math.floor(bytesRead / bytesPerFrame);
      const samples = new Float32Array(completeFrames * this.info.channels);
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = buffer.readInt16LE(i * 2) / 32_768;
      }
      seq += 1;
      yield {
        type: "audio",
        chunk: { seq, startSample: framesRead, samples },
      };
      framesRead += completeFrames;
      position += bytesRead;
      if ((this.options.pacing ?? "realtime") === "realtime" && framesRead < this.info.frames) {
        const audioMs = (framesRead / this.info.sampleRate) * 1000;
        const waitMs = audioMs - (Date.now() - startedAt);
        if (waitMs > 0) {
          await (
            this.options.sleep ??
            ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
          )(waitMs);
        }
      }
      if (position >= endOfData) {
        break;
      }
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
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return err(appError("RESOURCE_ACQUIRE_FAILED", "WAV input could not be opened"));
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close().catch(() => undefined);
      return err(appError("VALIDATION_FAILED", "WAV input must be a regular file"));
    }
    const headerBytes = Math.min(stat.size, 1_048_576);
    const buffer = Buffer.alloc(headerBytes);
    await handle.read(buffer, 0, headerBytes, 0);
    const parsed = parseWavHeader(buffer.subarray(0, headerBytes));
    if (parsed.isErr()) {
      await handle.close().catch(() => undefined);
      return err(parsed.error);
    }
    if (parsed.value.dataOffset + parsed.value.dataBytes > stat.size) {
      await handle.close().catch(() => undefined);
      return err(appError("VALIDATION_FAILED", "WAV data chunk extends beyond the file"));
    }
    const source = new WavCaptureSource(
      handle,
      parsed.value.info,
      parsed.value.dataOffset,
      parsed.value.dataBytes,
      options,
    );
    return ok(Object.assign(source, { info: parsed.value.info }));
  } catch {
    await handle.close().catch(() => undefined);
    return err(appError("RESOURCE_ACQUIRE_FAILED", "WAV input could not be read"));
  }
}
