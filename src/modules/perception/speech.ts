import { appError, toAppError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

import type { CaptureSource } from "./audio.js";
import { AudioConverter, type PcmEncoding } from "./convert.js";

export type SpeechMode = "endpointing" | "diarization";

export type SpeechProviderEvent =
  | { readonly type: "connectionEpoch"; readonly epoch: number; readonly uncertainMs: number }
  | { readonly type: "turnStarted"; readonly turnRef: string }
  | {
      readonly type: "partial";
      readonly turnRef?: string;
      readonly text: string;
      readonly audioProcessedMs?: number;
    }
  | { readonly type: "turnEnded"; readonly turnRef: string }
  | {
      readonly type: "speaker";
      readonly label: string;
      readonly audioProcessedMs?: number;
    }
  | {
      readonly type: "completed";
      readonly turnRef: string;
      readonly text: string;
      readonly audioProcessedMs?: number;
    }
  | { readonly type: "progress"; readonly audioProcessedMs: number };

export interface SpeechSession {
  readonly encoding: PcmEncoding;
  events(): AsyncIterable<SpeechProviderEvent>;
  sendAudio(pcm: Buffer): Promise<Result<void, AppError>>;
  endInput(): Promise<void>;
  terminate(): Promise<void>;
}

export interface OpenSpeechSessionOptions {
  readonly mode: SpeechMode;
  readonly keywords: readonly string[];
  readonly signal: AbortSignal;
}

export interface SpeechProvider {
  readonly providerId: string;
  readonly modelId: string;
  openSession(options: OpenSpeechSessionOptions): Promise<Result<SpeechSession, AppError>>;
}

export type TranscriptEvent =
  | {
      readonly type: "partial";
      readonly utteranceId: string;
      readonly revision: number;
      readonly text: string;
      readonly speaker?: string;
    }
  | {
      readonly type: "final";
      readonly utteranceId: string;
      readonly revision: number;
      readonly text: string;
      readonly speaker?: string;
    }
  | {
      readonly type: "discontinuity";
      readonly reason: "capture-gap" | "reconnect" | "uncertain-coverage";
      readonly detail: string;
    }
  | { readonly type: "progress"; readonly audioProcessedMs: number };

export interface TranscriptionSummary {
  readonly providerId: string;
  readonly modelId: string;
  readonly mode: SpeechMode;
  readonly finals: number;
  readonly partials: number;
  readonly discontinuities: number;
  readonly inputFrames: number;
  readonly outputFrames: number;
  readonly firstPartialMs?: number;
  readonly providerSessionId?: string;
}

interface TurnState {
  readonly utteranceId: string;
  revision: number;
  text: string;
  speaker?: string;
  finalized: boolean;
}

export class TranscriptReducer {
  private epoch = 0;
  private utteranceCounter = 0;
  private readonly turns = new Map<string, TurnState>();
  private currentTurnRef: string | undefined;
  private partials = 0;
  private finals = 0;

  get partialCount(): number {
    return this.partials;
  }

  get finalCount(): number {
    return this.finals;
  }

  apply(event: SpeechProviderEvent): Result<TranscriptEvent | undefined, AppError> {
    switch (event.type) {
      case "connectionEpoch": {
        this.epoch = event.epoch;
        this.turns.clear();
        this.currentTurnRef = undefined;
        if (event.epoch === 0) {
          return ok(undefined);
        }
        return ok({
          type: "discontinuity",
          reason: event.uncertainMs > 0 ? "uncertain-coverage" : "reconnect",
          detail: `provider connection epoch ${event.epoch} started; ${event.uncertainMs} ms of transmitted audio has uncertain processing coverage`,
        });
      }
      case "turnStarted": {
        this.ensureTurn(event.turnRef);
        this.currentTurnRef = event.turnRef;
        return ok(undefined);
      }
      case "turnEnded": {
        if (!this.turns.has(`${this.epoch}:${event.turnRef}`)) {
          return err(appError("VALIDATION_FAILED", "provider ended a turn that was never started"));
        }
        return ok(undefined);
      }
      case "speaker": {
        const turn = this.currentTurn();
        if (turn === undefined) {
          return err(appError("VALIDATION_FAILED", "provider speaker event has no active turn"));
        }
        turn.speaker = event.label;
        return ok(undefined);
      }
      case "progress": {
        return ok({ type: "progress", audioProcessedMs: event.audioProcessedMs });
      }
      case "partial": {
        const ref = event.turnRef ?? this.currentTurnRef;
        if (ref === undefined) {
          return err(
            appError(
              "VALIDATION_FAILED",
              "provider partial cannot be associated with a speech turn",
            ),
          );
        }
        const turn = this.ensureTurn(ref);
        if (turn.finalized) {
          return err(
            appError("VALIDATION_FAILED", "provider revised an already finalized utterance"),
          );
        }
        if (turn.text === event.text) {
          return ok(undefined);
        }
        turn.text = event.text;
        turn.revision += 1;
        this.partials += 1;
        return ok({
          type: "partial",
          utteranceId: turn.utteranceId,
          revision: turn.revision,
          text: turn.text,
          ...(turn.speaker === undefined ? {} : { speaker: turn.speaker }),
        });
      }
      case "completed": {
        const turn = this.ensureTurn(event.turnRef);
        if (turn.finalized) {
          if (turn.text === event.text) {
            return ok(undefined);
          }
          return err(
            appError(
              "VALIDATION_FAILED",
              "provider delivered a conflicting completion for a finalized utterance",
            ),
          );
        }
        turn.finalized = true;
        turn.text = event.text;
        turn.revision += 1;
        this.finals += 1;
        return ok({
          type: "final",
          utteranceId: turn.utteranceId,
          revision: turn.revision,
          text: turn.text,
          ...(turn.speaker === undefined ? {} : { speaker: turn.speaker }),
        });
      }
    }
  }

  private currentTurn(): TurnState | undefined {
    if (this.currentTurnRef === undefined) {
      return undefined;
    }
    return this.turns.get(`${this.epoch}:${this.currentTurnRef}`);
  }

  private ensureTurn(turnRef: string): TurnState {
    const key = `${this.epoch}:${turnRef}`;
    const existing = this.turns.get(key);
    if (existing !== undefined) {
      return existing;
    }
    this.utteranceCounter += 1;
    const created: TurnState = {
      utteranceId: `epoch-${this.epoch}-turn-${this.utteranceCounter}`,
      revision: 0,
      text: "",
      finalized: false,
    };
    this.turns.set(key, created);
    return created;
  }
}

export interface TranscriptionInput {
  readonly source: CaptureSource;
  readonly provider: SpeechProvider;
  readonly signal: AbortSignal;
  readonly mode: SpeechMode;
  readonly keywords: readonly string[];
  readonly durationMs?: number;
  readonly onEvent: (event: TranscriptEvent) => Promise<void>;
  readonly onFormat?: (format: { sampleRate: number; channels: number }) => Promise<void>;
}

const OUTPUT_TIMEOUT_MS = 5_000;

async function awaitOutput<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw appError("CANCELLED", "transcription cancelled");
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(appError("CANCELLED", "transcription cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      reject(appError("INTERNAL", "transcription output did not complete within its bound"));
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

export async function runTranscription(
  input: TranscriptionInput,
): Promise<Result<TranscriptionSummary, AppError>> {
  const opened = await input.provider.openSession({
    mode: input.mode,
    keywords: input.keywords,
    signal: input.signal,
  });
  if (opened.isErr()) {
    const disposed = await input.source.dispose();
    if (disposed.isErr()) {
      return err(opened.error);
    }
    return err(opened.error);
  }
  const session = opened.value;
  if (input.durationMs !== undefined) {
    if (
      !Number.isInteger(input.durationMs) ||
      input.durationMs < 1_000 ||
      input.durationMs > 300_000
    ) {
      await session.terminate().catch(() => undefined);
      await input.source.dispose().catch(() => undefined);
      return err(appError("VALIDATION_FAILED", "transcription duration must be 1 to 300 seconds"));
    }
  }
  const durationTimer =
    input.durationMs === undefined
      ? undefined
      : setTimeout(() => {
          void input.source.stop().catch(() => undefined);
        }, input.durationMs);
  const startedAt = Date.now();
  let firstPartialMs: number | undefined;
  let discontinuities = 0;
  const reducer = new TranscriptReducer();
  let failure: AppError | undefined;
  let converter: AudioConverter | undefined;
  let expectedSample = 0;

  const consumeEvents = (async (): Promise<void> => {
    try {
      for await (const providerEvent of session.events()) {
        if (input.signal.aborted) {
          throw appError("CANCELLED", "transcription cancelled");
        }
        const applied = reducer.apply(providerEvent);
        if (applied.isErr()) {
          throw applied.error;
        }
        if (applied.value === undefined) {
          continue;
        }
        if (applied.value.type === "discontinuity") {
          discontinuities += 1;
        }
        if (applied.value.type === "partial" && firstPartialMs === undefined) {
          firstPartialMs = Date.now() - startedAt;
        }
        await awaitOutput(input.onEvent(applied.value), input.signal);
      }
    } catch (thrown: unknown) {
      failure ??= toAppError(thrown, "transcription event consumption failed");
    }
  })();

  try {
    let sawFormat = false;
    let sawEnd = false;
    for await (const item of input.source.items(input.signal)) {
      if (input.signal.aborted) {
        throw appError("CANCELLED", "transcription cancelled");
      }
      if (failure !== undefined) {
        throw failure;
      }
      if (item.type === "format") {
        if (sawFormat) {
          throw appError("VALIDATION_FAILED", "audio source produced more than one format");
        }
        sawFormat = true;
        const created = AudioConverter.create(item.format);
        if (created.isErr()) {
          throw created.error;
        }
        converter = created.value;
        if (converter.outputEncoding !== session.encoding) {
          throw appError(
            "VALIDATION_FAILED",
            "audio conversion does not match the provider session encoding",
          );
        }
        if (input.onFormat !== undefined) {
          await awaitOutput(input.onFormat(item.format), input.signal);
        }
        continue;
      }
      if (!sawFormat || converter === undefined) {
        throw appError("VALIDATION_FAILED", "audio source produced audio before its format");
      }
      if (item.type === "end") {
        sawEnd = true;
        const flushed = converter.flush();
        if (flushed.pcm.length > 0) {
          const sent = await session.sendAudio(flushed.pcm);
          if (sent.isErr()) {
            throw sent.error;
          }
        }
        break;
      }
      if (item.chunk.startSample > expectedSample) {
        converter.noteGap();
        discontinuities += 1;
        await awaitOutput(
          input.onEvent({
            type: "discontinuity",
            reason: "capture-gap",
            detail: `capture gap from sample ${expectedSample} to ${item.chunk.startSample}; missing audio is not synthesized`,
          }),
          input.signal,
        );
        expectedSample = item.chunk.startSample;
      } else if (item.chunk.startSample < expectedSample) {
        throw appError("VALIDATION_FAILED", "audio source overlaps already received samples");
      }
      expectedSample += item.chunk.samples.length / converter.format.channels;
      const converted = converter.convert(item.chunk.samples);
      if (converted.isErr()) {
        throw converted.error;
      }
      if (converted.value.pcm.length > 0) {
        const sent = await session.sendAudio(converted.value.pcm);
        if (sent.isErr()) {
          throw sent.error;
        }
      }
    }
    if (!sawEnd) {
      throw appError("VALIDATION_FAILED", "audio source ended without helper acknowledgement");
    }
    if (durationTimer !== undefined) {
      clearTimeout(durationTimer);
    }
    await session.endInput();
    await consumeEvents;
    if (failure !== undefined) {
      return err(failure);
    }
    if (input.signal.aborted) {
      return err(appError("CANCELLED", "transcription cancelled"));
    }
    const disposed = await input.source.dispose();
    if (disposed.isErr()) {
      return err(disposed.error);
    }
    const stats = converter?.stats ?? { inputFrames: 0, outputFrames: 0 };
    return ok({
      providerId: input.provider.providerId,
      modelId: input.provider.modelId,
      mode: input.mode,
      finals: reducer.finalCount,
      partials: reducer.partialCount,
      discontinuities,
      inputFrames: stats.inputFrames,
      outputFrames: stats.outputFrames,
      ...(firstPartialMs === undefined ? {} : { firstPartialMs }),
    });
  } catch (thrown: unknown) {
    if (durationTimer !== undefined) {
      clearTimeout(durationTimer);
    }
    const primary = failure ?? toAppError(thrown, "transcription failed");
    await session.terminate().catch(() => undefined);
    await consumeEvents.catch(() => undefined);
    await input.source.dispose().catch(() => undefined);
    return err(primary);
  }
}
