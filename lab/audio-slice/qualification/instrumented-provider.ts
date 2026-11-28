import { err, ok, type Result } from "neverthrow";

import { appError, type AppError } from "../../../src/kernel/errors.js";
import type {
  OpenSpeechSessionOptions,
  SpeechProvider,
  SpeechProviderEvent,
  SpeechSession,
} from "../../../src/modules/perception/speech.js";

export const MUSE_PRICE_PER_HOUR_USD = 0.18;

export interface QualificationLimits {
  readonly maxAudioSeconds: number;
  readonly maxBillableSeconds: number;
  readonly maxAttempts: number;
  readonly pricePerHourUsd: number;
}

export interface ProviderObservation {
  readonly kind:
    "session-open" | "provider-event" | "audio-sent" | "session-closed" | "limit-reached";
  readonly monoMs: number;
  readonly detail: string;
  readonly bytes?: number;
  readonly transmittedSeconds?: number;
}

export interface InstrumentedProvider {
  readonly provider: SpeechProvider;
  readonly transmittedBytes: () => number;
  readonly transmittedSeconds: () => number;
  readonly estimatedCostUsd: () => number;
}

function bytesPerSecond(encoding: "PCM_16KHZ" | "PCM_24KHZ"): number {
  return encoding === "PCM_16KHZ" ? 32_000 : 48_000;
}

function describe(event: SpeechProviderEvent): string {
  switch (event.type) {
    case "connectionEpoch":
      return `connectionEpoch epoch=${event.epoch} uncertainMs=${event.uncertainMs}`;
    case "turnStarted":
      return `turnStarted turn=${event.turnRef}`;
    case "turnEnded":
      return `turnEnded turn=${event.turnRef}`;
    case "partial":
      return `partial turn=${event.turnRef ?? "none"} text=${event.text}`;
    case "completed":
      return `completed turn=${event.turnRef} text=${event.text}`;
    case "speaker":
      return `speaker label=${event.label}`;
    case "progress":
      return `progress audioProcessedMs=${event.audioProcessedMs}`;
  }
}

export function instrumentProvider(
  provider: SpeechProvider,
  limits: QualificationLimits,
  onObservation: (observation: ProviderObservation) => void,
  onLimitReached: (detail: string) => void,
  now: () => number = () => performance.now(),
): InstrumentedProvider {
  let transmittedBytes = 0;
  let rate = bytesPerSecond("PCM_24KHZ");
  const observed = (observation: ProviderObservation): void => {
    onObservation(observation);
  };
  const wrapped: SpeechProvider = {
    providerId: provider.providerId,
    modelId: provider.modelId,
    openSession: async (
      options: OpenSpeechSessionOptions,
    ): Promise<Result<SpeechSession, AppError>> => {
      const opened = await provider.openSession(options);
      if (opened.isErr()) return opened;
      const session = opened.value;
      rate = bytesPerSecond(session.encoding);
      observed({
        kind: "session-open",
        monoMs: now(),
        detail: `encoding=${session.encoding} provider=${provider.providerId} model=${provider.modelId}`,
      });
      const wrappedSession: SpeechSession = {
        encoding: session.encoding,
        providerSessionId: session.providerSessionId,
        events: async function* (): AsyncIterable<SpeechProviderEvent> {
          for await (const event of session.events()) {
            observed({
              kind: "provider-event",
              monoMs: now(),
              detail: describe(event),
            });
            yield event;
          }
        },
        sendAudio: async (pcm: Buffer): Promise<Result<void, AppError>> => {
          const nextBytes = transmittedBytes + pcm.length;
          const nextSeconds = nextBytes / rate;
          if (nextSeconds > limits.maxAudioSeconds || nextSeconds > limits.maxBillableSeconds) {
            const detail =
              `transmission limit reached at ${nextSeconds.toFixed(2)}s ` +
              `(per attempt ${limits.maxAudioSeconds}s, billable ${limits.maxBillableSeconds}s)`;
            observed({ kind: "limit-reached", monoMs: now(), detail });
            onLimitReached(detail);
            return err(appError("CONFIG_INVALID", detail));
          }
          const sent = await session.sendAudio(pcm);
          if (sent.isErr()) return sent;
          transmittedBytes = nextBytes;
          observed({
            kind: "audio-sent",
            monoMs: now(),
            detail: `${pcm.length} bytes at ${session.encoding}`,
            bytes: pcm.length,
            transmittedSeconds: nextSeconds,
          });
          return ok(undefined);
        },
        endInput: async (): Promise<Result<void, AppError>> => {
          observed({
            kind: "session-closed",
            monoMs: now(),
            detail: "endInput",
          });
          return session.endInput();
        },
        terminate: async (): Promise<Result<void, AppError>> => {
          observed({
            kind: "session-closed",
            monoMs: now(),
            detail: "terminate",
          });
          return session.terminate();
        },
      };
      return ok(wrappedSession);
    },
  };
  return {
    provider: wrapped,
    transmittedBytes: () => transmittedBytes,
    transmittedSeconds: () => transmittedBytes / rate,
    estimatedCostUsd: () => (transmittedBytes / rate / 3600) * limits.pricePerHourUsd,
  };
}
