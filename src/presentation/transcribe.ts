import type { Clock } from "@kernel/clock";
import { appError, toAppError, type AppError } from "@kernel/errors";
import {
  loadTranslationConfig,
  type TranslationConfig,
  type TranslationFlags,
} from "@modules/config/translation";
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
  readonly translationFlags?: TranslationFlags;
  readonly signal: AbortSignal;
  readonly output: CliOutput;
  readonly sttProvider?: string;
  readonly sttModel?: string;
}

type BilingualSummary = TranscriptionSummary & {
  readonly translation?: TranslationSummary;
};

export type TranscribePort = (
  input: TranscribeInput,
) => Promise<Result<BilingualSummary, AppError>>;

export interface TranscribeDeps {
  readonly clock: Clock;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly loopbackEndpoint: boolean;
  readonly translationLoopbackEndpoint: boolean;
  readonly createProvider?: (model?: string) => Result<SpeechProvider, AppError>;
  readonly createTranslator?: (
    config: Extract<TranslationConfig, { enabled: true }>,
  ) => Result<TranslationProvider, AppError>;
  readonly spawnCapture?: (input: {
    readonly syntheticFrames?: number;
  }) => Result<CaptureSource, AppError>;
  readonly openWav?: (
    path: string,
    smokeFixtureOnly: boolean,
  ) => Promise<Result<CaptureSource, AppError>>;
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
  const label = `${event.type} ${event.sourceLanguage} → ${event.targetLanguage} ${event.sourceUtteranceId} r${event.sourceRevision}`;
  switch (event.type) {
    case "provisional":
    case "committed":
      return `[translation ${label}${event.coverageUncertain ? " coverage uncertain" : ""}] ${event.text}`;
    case "invalidated":
      return `[translation ${label}]`;
    case "degraded":
      return `[translation ${label}] ${event.reason}`;
  }
}

function formatTranslationSummary(summary: TranslationSummary): string {
  return `translation ${summary.failed ? "degraded" : "complete"}: committed=${summary.committed}/${summary.finalized} uncovered=${summary.uncovered} provisionals=${summary.provisionals} staleRejected=${summary.staleRejected} requests=${summary.requests} unresolvedInvocations=${summary.unresolvedInvocations} unresolvedPublication=${summary.unresolvedPublication}`;
}

export function createTranscribePort(deps: TranscribeDeps): TranscribePort {
  return async (input) => {
    const { createProvider, openWav, spawnCapture } = deps;
    if (input.signal.aborted) {
      return err(appError("CANCELLED", "transcription cancelled"));
    }
    const env = deps.env ?? {};
    const speechProvider = input.sttProvider ?? env["URBUDDY_STT_PROVIDER"] ?? "muse";
    if (speechProvider !== "muse") {
      return err(appError("CONFIG_INVALID", "unsupported speech provider"));
    }
    const config = loadTranslationConfig(input.translate, input.translationFlags, env);
    if (config.isErr()) {
      return err(config.error);
    }
    const translationConfig = config.value;
    if (translationConfig.enabled && deps.loopbackEndpoint !== deps.translationLoopbackEndpoint) {
      return err(appError("CONFIG_INVALID", "bilingual test endpoints must both be loopback"));
    }

    if (createProvider === undefined) {
      return err(
        appError(
          "CONFIG_INVALID",
          "transcription requires network egress authorization (--allow-egress)",
        ),
      );
    }
    if (
      input.file === undefined &&
      (deps.loopbackEndpoint || (translationConfig.enabled && deps.translationLoopbackEndpoint))
    ) {
      return err(
        appError("CONFIG_INVALID", "live capture is not permitted with a loopback test endpoint"),
      );
    }
    if (input.translate && deps.createTranslator === undefined) {
      return err(
        appError(
          "CONFIG_INVALID",
          "translation requires network egress authorization (--allow-egress)",
        ),
      );
    }
    const translationController = new AbortController();
    const translationSignal = AbortSignal.any([input.signal, translationController.signal]);
    let scheduler: TranslationScheduler | undefined;
    async function fail(error: AppError): Promise<Result<BilingualSummary, AppError>> {
      translationController.abort();
      const cleanup = await scheduler?.finish();
      if (
        cleanup !== undefined &&
        (cleanup.unresolvedInvocations > 0 ||
          cleanup.unresolvedPublication ||
          cleanup.publicationFailures > 0)
      ) {
        return err(
          appError(error.code, `${error.message}; translation cleanup incomplete`, {
            ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId }),
            details: {
              ...error.details,
              translationCleanup: JSON.stringify({
                unresolvedInvocations: cleanup.unresolvedInvocations,
                unresolvedPublication: cleanup.unresolvedPublication,
                publicationFailures: cleanup.publicationFailures,
                uncovered: cleanup.uncovered,
              }),
            },
          }),
        );
      }
      return err(error);
    }
    try {
      if (translationConfig.enabled) {
        const created = deps.createTranslator?.(translationConfig);
        if (created === undefined || created.isErr()) {
          return err(created?.error ?? appError("CONFIG_INVALID", "translation is not configured"));
        }
        const recipient = deps.translationLoopbackEndpoint
          ? "local OpenAI test endpoint"
          : "OpenAI (api.openai.com)";
        await input.output.errLine(
          stripFormatting(
            `disclosure: transcript text and recent context will be sent to ${recipient} for ${translationConfig.sourceLanguage} → ${translationConfig.targetLanguage} translation (${created.value.modelId}). Urbuddy does not store this translation.`,
          ),
        );
        scheduler = new TranslationScheduler({
          provider: created.value,
          languages: translationConfig,
          signal: translationSignal,
          onEvent: async (event, isCurrent) => {
            if (!isCurrent()) {
              return false;
            }
            await input.output.out(
              input.json ? JSON.stringify(event) : stripFormatting(formatTranslationEvent(event)),
            );
            return true;
          },
        });
      }
      const provider = createProvider(input.sttModel ?? env["URBUDDY_STT_MODEL"]);
      if (provider.isErr()) {
        return await fail(provider.error);
      }
      if (input.signal.aborted) {
        return await fail(appError("CANCELLED", "transcription cancelled"));
      }
      let source: CaptureSource;
      if (input.file !== undefined) {
        if (openWav === undefined) {
          return await fail(appError("CONFIG_INVALID", "WAV transcription is not wired"));
        }
        const opened = await openWav(
          input.file,
          translationConfig.enabled && deps.translationLoopbackEndpoint,
        );
        if (opened.isErr()) {
          return await fail(opened.error);
        }
        source = opened.value;
      } else {
        await input.output.errLine(
          stripFormatting(
            "disclosure: system-wide macOS audio will be sent to the selected cloud speech provider (Meta Muse). No audio is stored by urbuddy.",
          ),
        );
        if (input.signal.aborted) {
          return await fail(appError("CANCELLED", "transcription cancelled"));
        }
        if (spawnCapture === undefined) {
          return await fail(
            appError(
              "CONFIG_INVALID",
              "live transcription requires child-process authorization (--allow-child)",
            ),
          );
        }
        const spawned = spawnCapture({});
        if (spawned.isErr()) {
          return await fail(spawned.error);
        }
        source = spawned.value;
      }
      const onEvent = async (event: TranscriptEvent): Promise<void> => {
        if (event.type === "progress") {
          return;
        }
        scheduler?.consume(event);
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
        return await fail(outcome.error);
      }
      const translation = await scheduler?.finish();
      if (translation !== undefined) {
        if (input.json) {
          await input.output.out(JSON.stringify({ type: "translation-complete", ...translation }));
        } else {
          await input.output.out(stripFormatting(formatTranslationSummary(translation)));
        }
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
      return await fail(toAppError(thrown, "transcription failed"));
    }
  };
}
