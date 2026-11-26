import type { Clock } from "@kernel/clock";
import { appError, toAppError, type AppError } from "@kernel/errors";
import {
  type AudioFormat,
  type CaptureSource,
  type CaptureStats,
  type CaptureSummary,
  type runCaptureSession,
} from "@modules/perception/audio";
import { stripFormatting } from "@platform/output";
import { err, type Result } from "neverthrow";

import type { CliOutput } from "./output.js";

export interface CaptureInput {
  readonly durationMs?: number;
  readonly syntheticFrames?: number;
  readonly json: boolean;
  readonly signal: AbortSignal;
  readonly output: CliOutput;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type CapturePort = (input: CaptureInput) => Promise<Result<CaptureSummary, AppError>>;

export interface CaptureDeps {
  readonly runSession: typeof runCaptureSession;
  readonly clock: Clock;
  readonly spawnSource?: (input: {
    readonly helperPath: string;
    readonly syntheticFrames?: number;
    readonly maxBufferedBytes?: number;
  }) => Result<CaptureSource, AppError>;
  readonly resolveHelper?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Result<string, AppError>;
}

function formatDb(rms: number): string {
  if (rms <= 0) {
    return "-inf";
  }
  return (20 * Math.log10(rms)).toFixed(1);
}

function formatStats(stats: CaptureStats): string {
  return (
    `capture stats: frames=${stats.receivedFrames} samples=${stats.receivedSamples} ` +
    `rms=${formatDb(stats.rms)} dBFS peak=${stats.peak.toFixed(3)} ` +
    `dropped=${stats.droppedHelper} gaps=${stats.gaps} elapsed=${(stats.elapsedMs / 1000).toFixed(1)}s`
  );
}

function formatSummary(summary: CaptureSummary, synthetic: boolean): string[] {
  const source = synthetic ? "synthetic transport test" : "macOS system audio";
  const lines = [
    `capture complete (${source}): ${summary.format.sampleRate} Hz ` +
      `${summary.format.channels}ch frames=${summary.receivedFrames} ` +
      `samples=${summary.receivedSamples} rms=${formatDb(summary.rms)} dBFS ` +
      `peak=${summary.peak.toFixed(3)} dropped=${summary.droppedHelper} gaps=${summary.gaps} ` +
      `signal=${summary.signalPresent ? "present" : "none"}`,
  ];
  if (!summary.signalPresent && !synthetic) {
    lines.push(
      "note: no audio signal was captured (indistinguishable from digital silence; " +
        "if sound was playing, the macOS system-audio consent grant is missing)",
    );
  }
  return lines;
}

export function createCapturePort(deps: CaptureDeps): CapturePort {
  return async (input) => {
    if (deps.spawnSource === undefined || deps.resolveHelper === undefined) {
      return err(
        appError("CONFIG_INVALID", "capture requires child-process authorization (--allow-child)"),
      );
    }
    const synthetic = input.syntheticFrames ?? 0;
    try {
      const helperPath = deps.resolveHelper(input.env);
      if (helperPath.isErr()) {
        return err(helperPath.error);
      }
      const source = deps.spawnSource({ helperPath: helperPath.value, syntheticFrames: synthetic });
      if (source.isErr()) {
        return err(source.error);
      }
      const outcome = await deps.runSession({
        source: source.value,
        signal: input.signal,
        clock: deps.clock,
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        onFormat: async (format: AudioFormat) => {
          if (input.json) {
            await input.output.out(
              JSON.stringify({
                type: "format",
                sampleRate: format.sampleRate,
                channels: format.channels,
              }),
            );
          } else {
            await input.output.out(
              stripFormatting(`capture ready: ${format.sampleRate} Hz ${format.channels}ch`),
            );
          }
        },
        onStats: async (stats: CaptureStats) => {
          if (input.json) {
            await input.output.out(JSON.stringify({ type: "stats", ...stats }));
          } else {
            await input.output.out(stripFormatting(formatStats(stats)));
          }
        },
      });
      if (outcome.isErr()) {
        return err(outcome.error);
      }
      if (input.json) {
        await input.output.out(JSON.stringify({ type: "complete", ...outcome.value }));
      } else {
        for (const line of formatSummary(outcome.value, synthetic > 0)) {
          await input.output.out(stripFormatting(line));
        }
      }
      return outcome;
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "capture failed"));
    }
  };
}
