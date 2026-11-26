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
  let format: AudioFormat | undefined;
  let audioCount = 0;
  let expectedSample = 0;
  let receivedSamples = 0;
  let receivedFrames = 0;
  let sumSq = 0;
  let peak = 0;
  let signalPresent = false;
  let helper: HelperEnd | undefined;
  const gaps: CaptureGap[] = [];
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
        receivedFrames: audioCount,
        receivedSamples,
        droppedHelper: helper?.dropped ?? 0,
        gaps: gaps.length,
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
        if (format !== undefined) {
          throw appError("VALIDATION_FAILED", "capture produced more than one audio format");
        }
        if (item.seq !== 0) {
          throw appError("VALIDATION_FAILED", "capture format frame breaks sequence continuity");
        }
        format = item.format;
        if (input.onFormat !== undefined) {
          await awaitOutput(input.onFormat(format), signal);
        }
        continue;
      }
      if (format === undefined) {
        throw appError("VALIDATION_FAILED", "capture produced audio before its format");
      }
      if (item.type === "end") {
        if (item.seq !== audioCount + 1) {
          throw appError("VALIDATION_FAILED", "capture end frame breaks sequence continuity");
        }
        helper = item.end;
        if (item.end.reason === "cancelled" && !gracefulStop()) {
          throw appError("CANCELLED", "capture cancelled");
        }
        break;
      }
      audioCount += 1;
      if (item.chunk.seq !== audioCount) {
        throw appError("VALIDATION_FAILED", "capture audio sequence is not contiguous");
      }
      if (item.chunk.startSample > expectedSample) {
        gaps.push({ fromSample: expectedSample, toSample: item.chunk.startSample });
        expectedSample = item.chunk.startSample;
      } else if (item.chunk.startSample < expectedSample) {
        throw appError("VALIDATION_FAILED", "capture audio overlaps already received samples");
      }
      const perChannel = item.chunk.samples.length / format.channels;
      if (!Number.isInteger(perChannel) || perChannel === 0) {
        throw appError("VALIDATION_FAILED", "capture audio frame does not match its format");
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
      receivedFrames += perChannel;
      expectedSample += perChannel;
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
  if (helper.delivered !== audioCount) {
    return err(appError("VALIDATION_FAILED", "helper delivery count contradicts received audio"));
  }
  let accounted = receivedFrames;
  for (const gap of gaps) {
    accounted += gap.toSample - gap.fromSample;
  }
  const residual = helper.sourceFrames - accounted;
  if (residual < 0) {
    return err(appError("VALIDATION_FAILED", "helper source clock contradicts received audio"));
  }
  if (residual > 0) {
    gaps.push({ fromSample: expectedSample, toSample: expectedSample + residual });
  }
  return ok({
    format,
    receivedFrames: audioCount,
    receivedSamples,
    droppedHelper: helper.dropped,
    gaps: gaps.length,
    gapRanges: gaps,
    helperCaptured: helper.captured,
    helperDelivered: helper.delivered,
    rms: receivedSamples === 0 ? 0 : Math.sqrt(sumSq / receivedSamples),
    peak,
    elapsedMs: input.clock.now() - startedAt,
    signalPresent,
    endReason: "completed",
  });
}
