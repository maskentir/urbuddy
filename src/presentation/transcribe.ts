import type { Clock } from "@kernel/clock";
import { appError, toAppError, type AppError } from "@kernel/errors";
import type { CaptureSource } from "@modules/perception/audio";
import {
  runTranscription,
  type SpeechMode,
  type SpeechProvider,
  type TranscriptEvent,
  type TranscriptionSummary,
} from "@modules/perception/speech";
import { stripFormatting } from "@platform/output";
import { err, type Result } from "neverthrow";

import type { CliOutput } from "./output.js";

export interface TranscribeInput {
  readonly file?: string;
  readonly durationMs?: number;
  readonly mode: SpeechMode;
  readonly keywords: readonly string[];
  readonly json: boolean;
  readonly signal: AbortSignal;
  readonly output: CliOutput;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type TranscribePort = (
  input: TranscribeInput,
) => Promise<Result<TranscriptionSummary, AppError>>;

export interface TranscribeDeps {
  readonly clock: Clock;
  readonly createProvider?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Result<SpeechProvider, AppError>;
  readonly spawnCapture?: (input: {
    readonly syntheticFrames?: number;
  }) => Result<CaptureSource, AppError>;
  readonly openWav?: (path: string) => Promise<Result<CaptureSource, AppError>>;
  readonly runLiveCapture?: (input: {
    readonly source: CaptureSource;
    readonly provider: SpeechProvider;
    readonly signal: AbortSignal;
    readonly mode: SpeechMode;
    readonly keywords: readonly string[];
    readonly onEvent: (event: TranscriptEvent) => Promise<void>;
  }) => Promise<Result<TranscriptionSummary, AppError>>;
}

function formatEvent(event: TranscriptEvent): string {
  switch (event.type) {
    case "partial":
      return `[partial] ${event.speaker === undefined ? "" : `${event.speaker}: `}${event.text}`;
    case "final":
      return `[final] ${event.speaker === undefined ? "" : `${event.speaker}: `}${event.text}`;
    case "discontinuity":
      return `[gap: ${event.reason}] ${event.detail}`;
    case "progress":
      return `[progress] audio processed ${event.audioProcessedMs} ms`;
  }
}

export function createTranscribePort(deps: TranscribeDeps): TranscribePort {
  return async (input) => {
    if (deps.createProvider === undefined) {
      return err(
        appError(
          "CONFIG_INVALID",
          "transcription requires network egress authorization (--allow-egress)",
        ),
      );
    }
    if (input.file === undefined && deps.spawnCapture === undefined) {
      return err(
        appError(
          "CONFIG_INVALID",
          "live transcription requires child-process authorization (--allow-child)",
        ),
      );
    }
    if (input.file !== undefined && deps.openWav === undefined) {
      return err(appError("CONFIG_INVALID", "WAV transcription is not wired"));
    }
    try {
      const provider = deps.createProvider(input.env);
      if (provider.isErr()) {
        return err(provider.error);
      }
      let source: CaptureSource;
      if (input.file !== undefined) {
        const opened = await (deps.openWav as NonNullable<TranscribeDeps["openWav"]>)(input.file);
        if (opened.isErr()) {
          return err(opened.error);
        }
        source = opened.value;
      } else {
        if (!input.json) {
          await input.output.out(
            stripFormatting(
              "disclosure: system-wide macOS audio will be sent to the selected cloud speech provider (Meta Muse). No audio is stored by urbuddy.",
            ),
          );
        }
        const spawned = (deps.spawnCapture as NonNullable<TranscribeDeps["spawnCapture"]>)({});
        if (spawned.isErr()) {
          return err(spawned.error);
        }
        source = spawned.value;
      }
      const onEvent = async (event: TranscriptEvent): Promise<void> => {
        if (event.type === "progress") {
          return;
        }
        if (input.json) {
          await input.output.out(JSON.stringify(event));
        } else {
          await input.output.out(stripFormatting(formatEvent(event)));
        }
      };
      const outcome = await runTranscription({
        source,
        provider: provider.value,
        signal: input.signal,
        mode: input.mode,
        keywords: input.keywords,
        onEvent,
        ...(input.file === undefined && input.durationMs !== undefined
          ? { durationMs: input.durationMs }
          : {}),
      });
      if (outcome.isErr()) {
        return err(outcome.error);
      }
      if (input.json) {
        await input.output.out(JSON.stringify({ type: "complete", ...outcome.value }));
      } else {
        await input.output.out(
          stripFormatting(
            `transcription complete: provider=${outcome.value.providerId} model=${outcome.value.modelId} finals=${outcome.value.finals} partials=${outcome.value.partials} discontinuities=${outcome.value.discontinuities}`,
          ),
        );
      }
      return outcome;
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "transcription failed"));
    }
  };
}
