import type { Clock } from "@kernel/clock";
import { appError, toAppError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

export interface AudioFormat {
  readonly sampleRate: number;
  readonly channels: number;
}

export interface AudioChunk {
  readonly seq: number;
  readonly startSample: number;
  readonly samples: Float32Array;
}

export interface HelperEnd {
  readonly captured: number;
  readonly delivered: number;
  readonly dropped: number;
  readonly reason: "completed" | "cancelled";
  readonly sourceFrames: number;
}

export type SourceItem =
  | { readonly type: "format"; readonly seq: number; readonly format: AudioFormat }
  | { readonly type: "audio"; readonly chunk: AudioChunk }
  | { readonly type: "end"; readonly seq: number; readonly end: HelperEnd };

export interface CaptureSource {
  items(signal: AbortSignal): AsyncIterable<SourceItem>;
  stop(): Promise<void>;
  dispose(): Promise<Result<void, AppError>>;
}

export interface CaptureGap {
  readonly fromSample: number;
  readonly toSample: number;
}

export interface CaptureStats {
  readonly receivedFrames: number;
  readonly receivedSamples: number;
  readonly droppedHelper: number;
  readonly gaps: number;
  readonly rms: number;
  readonly peak: number;
  readonly elapsedMs: number;
}

export interface CaptureSummary extends CaptureStats {
  readonly format: AudioFormat;
  readonly gapRanges: readonly CaptureGap[];
  readonly helperCaptured: number;
  readonly helperDelivered: number;
  readonly signalPresent: boolean;
  readonly endReason: "completed" | "cancelled";
}

export interface ValidatedChunk {
  readonly perChannel: number;
  readonly gap: CaptureGap | undefined;
}

export interface ValidatedEnd {
  readonly helper: HelperEnd;
  readonly tailGap: CaptureGap | undefined;
}

export class SourceValidator {
  private format: AudioFormat | undefined;
  private audioCount = 0;
  private expectedSample = 0;
  private receivedFrames = 0;
  private readonly gaps: CaptureGap[] = [];

  get gapRanges(): readonly CaptureGap[] {
    return this.gaps;
  }

  get audioFrames(): number {
    return this.audioCount;
  }

  feedFormat(seq: number, format: AudioFormat): Result<AudioFormat, AppError> {
    if (this.format !== undefined) {
      return err(appError("VALIDATION_FAILED", "capture produced more than one audio format"));
    }
    if (seq !== 0) {
      return err(appError("VALIDATION_FAILED", "capture format frame breaks sequence continuity"));
    }
    this.format = format;
    return ok(format);
  }

  feedAudio(chunk: AudioChunk): Result<ValidatedChunk, AppError> {
    const format = this.format;
    if (format === undefined) {
      return err(appError("VALIDATION_FAILED", "capture produced audio before its format"));
    }
    this.audioCount += 1;
    if (chunk.seq !== this.audioCount) {
      return err(appError("VALIDATION_FAILED", "capture audio sequence is not contiguous"));
    }
    let gap: CaptureGap | undefined;
    if (chunk.startSample > this.expectedSample) {
      gap = { fromSample: this.expectedSample, toSample: chunk.startSample };
      this.gaps.push(gap);
      this.expectedSample = chunk.startSample;
    } else if (chunk.startSample < this.expectedSample) {
      return err(appError("VALIDATION_FAILED", "capture audio overlaps already received samples"));
    }
    const perChannel = chunk.samples.length / format.channels;
    if (!Number.isInteger(perChannel) || perChannel === 0) {
      return err(appError("VALIDATION_FAILED", "capture audio frame does not match its format"));
    }
    this.receivedFrames += perChannel;
    this.expectedSample += perChannel;
    return ok({ perChannel, gap });
  }

  feedEnd(seq: number, end: HelperEnd): Result<ValidatedEnd, AppError> {
    if (this.format === undefined) {
      return err(appError("VALIDATION_FAILED", "capture ended without audio format"));
    }
    if (seq !== this.audioCount + 1) {
      return err(appError("VALIDATION_FAILED", "capture end frame breaks sequence continuity"));
    }
    if (end.delivered !== this.audioCount) {
      return err(appError("VALIDATION_FAILED", "helper delivery count contradicts received audio"));
    }
    let accounted = this.receivedFrames;
    for (const gap of this.gaps) {
      accounted += gap.toSample - gap.fromSample;
    }
    const residual = end.sourceFrames - accounted;
    if (residual < 0) {
      return err(appError("VALIDATION_FAILED", "helper source clock contradicts received audio"));
    }
    let tailGap: CaptureGap | undefined;
    if (residual > 0) {
      tailGap = { fromSample: this.expectedSample, toSample: this.expectedSample + residual };
      this.gaps.push(tailGap);
    }
    return ok({ helper: end, tailGap });
  }
}

export interface CaptureSessionInput {
  readonly source: CaptureSource;
  readonly signal: AbortSignal;
  readonly clock: Clock;
  readonly durationMs?: number;
  readonly onFormat?: (format: AudioFormat) => Promise<void>;
  readonly onStats?: (stats: CaptureStats) => Promise<void>;
}

const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 300_000;
const STATS_INTERVAL_MS = 1_000;
const OUTPUT_TIMEOUT_MS = 5_000;

async function awaitOutput<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(appError("CANCELLED", "capture cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(appError("CANCELLED", "capture cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      reject(appError("INTERNAL", "capture output did not complete within its bound"));
    }, OUTPUT_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (reason: unknown) => {
        cleanup();
        reject(reason);
      },
    );
  });
}

function checkDuration(durationMs: number | undefined): Result<number, AppError> {
  if (durationMs === undefined) {
    return ok(MAX_DURATION_MS);
  }
  if (
    !Number.isInteger(durationMs) ||
    durationMs < MIN_DURATION_MS ||
    durationMs > MAX_DURATION_MS
  ) {
    return err(appError("VALIDATION_FAILED", "capture duration must be 1 to 300 seconds"));
  }
  return ok(durationMs);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw appError("CANCELLED", "capture cancelled");
  }
}

export async function runCaptureSession(
  input: CaptureSessionInput,
): Promise<Result<CaptureSummary, AppError>> {
  const duration = checkDuration(input.durationMs);
  if (duration.isErr()) {
    return err(duration.error);
  }
  let gracefulStop = false;
  const timer = setTimeout(() => {
    gracefulStop = true;
    void input.source.stop().catch(() => undefined);
  }, duration.value);
  let outcome: Result<CaptureSummary, AppError>;
  try {
    outcome = await settleCapture(input, input.signal, () => gracefulStop);
  } finally {
    clearTimeout(timer);
  }
  try {
    const disposed = await input.source.dispose();
    if (disposed.isErr() && outcome.isOk()) {
      return err(disposed.error);
    }
    return outcome;
  } catch (thrown: unknown) {
    if (outcome.isErr()) {
      return outcome;
    }
    return err(toAppError(thrown, "capture cleanup failed"));
  }
}

async function settleCapture(
  input: CaptureSessionInput,
  signal: AbortSignal,
  gracefulStop: () => boolean,
): Promise<Result<CaptureSummary, AppError>> {
  const startedAt = input.clock.now();
  let lastStatsAt = startedAt;
  const validator = new SourceValidator();
  let format: AudioFormat | undefined;
  let receivedSamples = 0;
  let sumSq = 0;
  let peak = 0;
  let signalPresent = false;
  let helper: HelperEnd | undefined;
  const emitStats = async (): Promise<void> => {
    const now = input.clock.now();
    if (now - lastStatsAt < STATS_INTERVAL_MS) {
      return;
    }
    lastStatsAt = now;
    if (input.onStats === undefined) {
      return;
    }
    await awaitOutput(
      input.onStats({
        receivedFrames: validator.audioFrames,
        receivedSamples,
        droppedHelper: helper?.dropped ?? 0,
        gaps: validator.gapRanges.length,
        rms: receivedSamples === 0 ? 0 : Math.sqrt(sumSq / receivedSamples),
        peak,
        elapsedMs: now - startedAt,
      }),
      signal,
    );
  };
  try {
    throwIfAborted(signal);
    for await (const item of input.source.items(signal)) {
      throwIfAborted(signal);
      if (item.type === "format") {
        const accepted = validator.feedFormat(item.seq, item.format);
        if (accepted.isErr()) {
          throw accepted.error;
        }
        format = accepted.value;
        if (input.onFormat !== undefined) {
          await awaitOutput(input.onFormat(format), signal);
        }
        continue;
      }
      if (item.type === "end") {
        const accepted = validator.feedEnd(item.seq, item.end);
        if (accepted.isErr()) {
          throw accepted.error;
        }
        helper = accepted.value.helper;
        if (item.end.reason === "cancelled" && !gracefulStop()) {
          throw appError("CANCELLED", "capture cancelled");
        }
        break;
      }
      const accepted = validator.feedAudio(item.chunk);
      if (accepted.isErr()) {
        throw accepted.error;
      }
      for (const value of item.chunk.samples) {
        const magnitude = Math.abs(value);
        if (magnitude > peak) {
          peak = magnitude;
        }
        if (value !== 0) {
          signalPresent = true;
        }
        sumSq += value * value;
      }
      receivedSamples += item.chunk.samples.length;
      await emitStats();
    }
    throwIfAborted(signal);
  } catch (thrown: unknown) {
    return err(toAppError(thrown, "capture failed"));
  }
  if (format === undefined) {
    return err(appError("VALIDATION_FAILED", "capture produced no audio format"));
  }
  if (helper === undefined) {
    return err(appError("VALIDATION_FAILED", "capture ended without helper acknowledgement"));
  }
  const gapRanges = validator.gapRanges;
  return ok({
    format,
    receivedFrames: validator.audioFrames,
    receivedSamples,
    droppedHelper: helper.dropped,
    gaps: gapRanges.length,
    gapRanges,
    helperCaptured: helper.captured,
    helperDelivered: helper.delivered,
    rms: receivedSamples === 0 ? 0 : Math.sqrt(sumSq / receivedSamples),
    peak,
    elapsedMs: input.clock.now() - startedAt,
    signalPresent,
    endReason: "completed",
  });
}
