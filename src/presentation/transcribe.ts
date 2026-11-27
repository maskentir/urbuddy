import type { Clock } from "@kernel/clock";
import { appError, toAppError, type AppError } from "@kernel/errors";
import {
  TranslationScheduler,
  type TranslationEvent,
  type TranslationProvider,
  type TranslationSummary,
} from "@modules/language/translation";
import type { CaptureSource } from "@modules/perception/audio";
import {
  runTranscription,
  type SpeechMode,
  type SpeechProvider,
  type TranscriptEvent,
  type TranscriptionSummary,
} from "@modules/perception/speech";
import { stripFormatting } from "@platform/output";
import { err, ok, type Result } from "neverthrow";

import type { CliOutput } from "./output.js";

export interface TranscribeInput {
  readonly file?: string;
  readonly durationMs?: number;
  readonly mode: SpeechMode;
  readonly keywords: readonly string[];
  readonly json: boolean;
  readonly translate: boolean;
  readonly signal: AbortSignal;
  readonly output: CliOutput;
  readonly env: Readonly<Record<string, string | undefined>>;
}

type BilingualSummary = TranscriptionSummary & {
  readonly translation?: TranslationSummary;
};

export type TranscribePort = (
  input: TranscribeInput,
) => Promise<Result<BilingualSummary, AppError>>;

export interface TranscribeDeps {
  readonly clock: Clock;
  readonly loopbackEndpoint: boolean;
  readonly translationLoopbackEndpoint: boolean;
  readonly createProvider?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Result<SpeechProvider, AppError>;
  readonly createTranslator?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Result<TranslationProvider, AppError>;
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

function formatTranslationEvent(event: TranslationEvent): string {
  switch (event.type) {
    case "provisional":
      return `[translation provisional] ${event.text}`;
    case "committed":
      return `[translation] ${event.text}`;
    case "degraded":
      return `[translation degraded: ${event.reason}] ${event.unitId}`;
  }
}

function formatTranslationSummary(summary: TranslationSummary): string {
  return (
    `translation complete: committed=${summary.committed} provisionals=${summary.provisionals} ` +
    `staleRejected=${summary.staleRejected} degraded=${summary.degraded} requests=${summary.requests}`
  );
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
    if (input.file === undefined && deps.loopbackEndpoint) {
      return err(
        appError("CONFIG_INVALID", "live capture is not permitted with a loopback test endpoint"),
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
    if (input.translate && deps.createTranslator === undefined) {
      return err(
        appError(
          "CONFIG_INVALID",
          "translation requires network egress authorization (--allow-egress)",
        ),
      );
    }
    try {
      const provider = deps.createProvider(input.env);
      if (provider.isErr()) {
        return err(provider.error);
      }
      const translationController = new AbortController();
      const stopTranslation = (): void => {
        translationController.abort();
      };
      input.signal.addEventListener("abort", stopTranslation, { once: true });
      let scheduler: TranslationScheduler | undefined;
      if (input.translate) {
        const created = (deps.createTranslator as NonNullable<TranscribeDeps["createTranslator"]>)(
          input.env,
        );
        if (created.isErr()) {
          input.signal.removeEventListener("abort", stopTranslation);
          return err(created.error);
        }
        await input.output.errLine(
          stripFormatting(
            "disclosure: English transcripts will be sent to the selected cloud translation provider (OpenAI) for Indonesian translation. No transcripts are stored by urbuddy.",
          ),
        );
        scheduler = new TranslationScheduler({
          provider: created.value,
          signal: translationController.signal,
          onEvent: async (event) => {
            if (input.json) {
              await input.output.out(JSON.stringify(event));
            } else {
              await input.output.out(stripFormatting(formatTranslationEvent(event)));
            }
          },
        });
      }
      let source: CaptureSource;
      if (input.file !== undefined) {
        const opened = await (deps.openWav as NonNullable<TranscribeDeps["openWav"]>)(input.file);
        if (opened.isErr()) {
          return err(opened.error);
        }
        source = opened.value;
      } else {
        await input.output.errLine(
          stripFormatting(
            "disclosure: system-wide macOS audio will be sent to the selected cloud speech provider (Meta Muse). No audio is stored by urbuddy.",
          ),
        );
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
        await scheduler?.consume(event);
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
        stopTranslation();
        input.signal.removeEventListener("abort", stopTranslation);
        if (scheduler !== undefined) {
          await scheduler.finish();
        }
        return err(outcome.error);
      }
      let translation: TranslationSummary | undefined;
      if (scheduler !== undefined) {
        translation = await scheduler.finish();
        input.signal.removeEventListener("abort", stopTranslation);
        if (input.json) {
          await input.output.out(JSON.stringify({ type: "translation-complete", ...translation }));
        } else {
          await input.output.out(stripFormatting(formatTranslationSummary(translation)));
        }
      } else {
        input.signal.removeEventListener("abort", stopTranslation);
      }
      if (input.json) {
        await input.output.out(
          JSON.stringify({
            type: "complete",
            ...outcome.value,
            ...(translation === undefined ? {} : { translation }),
          }),
        );
      } else {
        await input.output.out(
          stripFormatting(
            `transcription complete: provider=${outcome.value.providerId} model=${outcome.value.modelId} finals=${outcome.value.finals} partials=${outcome.value.partials} discontinuities=${outcome.value.discontinuities}`,
          ),
        );
      }
      return ok({
        ...outcome.value,
        ...(translation === undefined ? {} : { translation }),
      });
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "transcription failed"));
    }
  };
}
