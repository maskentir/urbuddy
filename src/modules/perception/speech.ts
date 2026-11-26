import { appError, toAppError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

import { SourceValidator, type CaptureSource } from "./audio.js";
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
  readonly providerSessionId: string | undefined;
  events(): AsyncIterable<SpeechProviderEvent>;
  sendAudio(pcm: Buffer): Promise<Result<void, AppError>>;
  endInput(): Promise<void>;
  terminate(): Promise<void>;
}

export interface OpenSpeechSessionOptions {
  readonly mode: SpeechMode;
  readonly encoding: PcmEncoding;
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
  private readonly pending: TranscriptEvent[] = [];

  get partialCount(): number {
    return this.partials;
  }

  get finalCount(): number {
    return this.finals;
  }

  drainPending(): TranscriptEvent[] {
    return this.pending.splice(0, this.pending.length);
  }

  private collectUnresolved(reason: string): TranscriptEvent[] {
    const unresolved: TranscriptEvent[] = [];
    for (const turn of this.turns.values()) {
      if (!turn.finalized) {
        unresolved.push({
          type: "discontinuity",
          reason: "uncertain-coverage",
          detail:
            `${reason} utterance ${turn.utteranceId} never finalized; ` +
            (turn.text.length === 0
              ? "no transcript text was received"
              : `last partial "${turn.text.slice(0, 120)}" is not final coverage`),
        });
      }
    }
    return unresolved;
  }

  apply(event: SpeechProviderEvent): Result<TranscriptEvent | undefined, AppError> {
    switch (event.type) {
      case "connectionEpoch": {
        const unresolved = this.collectUnresolved(`epoch ${this.epoch} ended;`);
        this.epoch = event.epoch;
        this.turns.clear();
        this.currentTurnRef = undefined;
        if (event.epoch === 0) {
          return ok(undefined);
        }
        for (const item of unresolved) {
          this.pending.push(item);
        }
        return ok({
          type: "discontinuity",
          reason: event.uncertainMs > 0 ? "uncertain-coverage" : "reconnect",
          detail:
            `provider connection epoch ${event.epoch} started; ` +
            `${event.uncertainMs} ms of transmitted audio has uncertain processing coverage` +
            (unresolved.length === 0 ? "" : `; ${unresolved.length} unresolved turn(s) abandoned`),
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

  close(): TranscriptEvent[] {
    const unresolved = this.collectUnresolved("session ended;");
    this.turns.clear();
    this.currentTurnRef = undefined;
    return unresolved;
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

async function emitDiscontinuity(
  input: TranscriptionInput,
  reason: "capture-gap" | "reconnect" | "uncertain-coverage",
  detail: string,
): Promise<void> {
  await awaitOutput(input.onEvent({ type: "discontinuity", reason, detail }), input.signal);
}

export async function runTranscription(
  input: TranscriptionInput,
): Promise<Result<TranscriptionSummary, AppError>> {
  if (
    input.durationMs !== undefined &&
    (!Number.isInteger(input.durationMs) || input.durationMs < 1_000 || input.durationMs > 300_000)
  ) {
    await input.source.dispose().catch(() => undefined);
    return err(appError("VALIDATION_FAILED", "transcription duration must be 1 to 300 seconds"));
  }
  const startedAt = Date.now();
  let firstPartialMs: number | undefined;
  let discontinuities = 0;
  const reducer = new TranscriptReducer();
  const validator = new SourceValidator();
  let failure: AppError | undefined;
  let session: SpeechSession | undefined;
  let converter: AudioConverter | undefined;
  let consumeEvents: Promise<void> = Promise.resolve();
  const operation = new AbortController();
  const releaseCallerAbort = (): void => {
    operation.abort();
  };
  input.signal.addEventListener("abort", releaseCallerAbort, { once: true });

  const observe = async (event: TranscriptEvent): Promise<void> => {
    if (event.type === "discontinuity") {
      discontinuities += 1;
    }
    if (event.type === "partial" && firstPartialMs === undefined) {
      firstPartialMs = Date.now() - startedAt;
    }
    await awaitOutput(input.onEvent(event), input.signal);
  };

  const startConsumer = (active: SpeechSession): void => {
    consumeEvents = (async (): Promise<void> => {
      try {
        for await (const providerEvent of active.events()) {
          if (input.signal.aborted) {
            throw appError("CANCELLED", "transcription cancelled");
          }
          const applied = reducer.apply(providerEvent);
          if (applied.isErr()) {
            throw applied.error;
          }
          if (applied.value !== undefined) {
            await observe(applied.value);
          }
          for (const queued of reducer.drainPending()) {
            await observe(queued);
          }
        }
      } catch (thrown: unknown) {
        failure ??= toAppError(thrown, "transcription event consumption failed");
        operation.abort();
      }
    })();
  };

  const durationTimer =
    input.durationMs === undefined
      ? undefined
      : setTimeout(() => {
          void input.source.stop().catch(() => undefined);
        }, input.durationMs);
  try {
    let sawEnd = false;
    for await (const item of input.source.items(operation.signal)) {
      if (input.signal.aborted) {
        throw appError("CANCELLED", "transcription cancelled");
      }
      if (failure !== undefined) {
        throw failure;
      }
      if (item.type === "format") {
        const accepted = validator.feedFormat(item.seq, item.format);
        if (accepted.isErr()) {
          throw accepted.error;
        }
        const created = AudioConverter.create(accepted.value);
        if (created.isErr()) {
          throw created.error;
        }
        converter = created.value;
        const opened = await input.provider.openSession({
          mode: input.mode,
          encoding: converter.outputEncoding,
          keywords: input.keywords,
          signal: input.signal,
        });
        if (opened.isErr()) {
          throw opened.error;
        }
        session = opened.value;
        if (session.encoding !== converter.outputEncoding) {
          throw appError(
            "VALIDATION_FAILED",
            "audio conversion does not match the provider session encoding",
          );
        }
        startConsumer(session);
        if (input.onFormat !== undefined) {
          await awaitOutput(input.onFormat(accepted.value), input.signal);
        }
        continue;
      }
      if (converter === undefined || session === undefined) {
        throw appError("VALIDATION_FAILED", "audio source produced audio before its format");
      }
      if (item.type === "end") {
        const accepted = validator.feedEnd(item.seq, item.end);
        if (accepted.isErr()) {
          throw accepted.error;
        }
        if (accepted.value.tailGap !== undefined) {
          const gap = accepted.value.tailGap;
          discontinuities += 1;
          converter.noteGap();
          await emitDiscontinuity(
            input,
            "capture-gap",
            `capture tail gap from sample ${gap.fromSample} to ${gap.toSample}; missing audio is not synthesized`,
          );
        }
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
      const accepted = validator.feedAudio(item.chunk);
      if (accepted.isErr()) {
        throw accepted.error;
      }
      if (accepted.value.gap !== undefined) {
        const gap = accepted.value.gap;
        converter.noteGap();
        discontinuities += 1;
        await emitDiscontinuity(
          input,
          "capture-gap",
          `capture gap from sample ${gap.fromSample} to ${gap.toSample}; missing audio is not synthesized`,
        );
      }
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
    if (session === undefined) {
      throw appError("VALIDATION_FAILED", "audio source produced no audio format");
    }
    if (durationTimer !== undefined) {
      clearTimeout(durationTimer);
    }
    await session.endInput();
    const operationRejected = new Promise<never>((_resolve, reject) => {
      if (operation.signal.aborted) {
        reject(appError("CANCELLED", "transcription cancelled"));
        return;
      }
      operation.signal.addEventListener(
        "abort",
        () => reject(appError("CANCELLED", "transcription cancelled")),
        { once: true },
      );
    });
    await Promise.race([consumeEvents, operationRejected]);
    input.signal.removeEventListener("abort", releaseCallerAbort);
    if (failure !== undefined) {
      throw failure;
    }
    if (input.signal.aborted) {
      throw appError("CANCELLED", "transcription cancelled");
    }
    for (const unresolved of reducer.close()) {
      await observe(unresolved);
    }
    for (const queued of reducer.drainPending()) {
      await observe(queued);
    }
    const disposed = await input.source.dispose();
    if (disposed.isErr()) {
      await session.terminate().catch(() => undefined);
      return err(disposed.error);
    }
    await session.terminate().catch(() => undefined);
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
      ...(session.providerSessionId === undefined
        ? {}
        : { providerSessionId: session.providerSessionId }),
    });
  } catch (thrown: unknown) {
    if (durationTimer !== undefined) {
      clearTimeout(durationTimer);
    }
    input.signal.removeEventListener("abort", releaseCallerAbort);
    const primary = failure ?? toAppError(thrown, "transcription failed");
    const stopError = await input.source
      .stop()
      .then(() => undefined)
      .catch((stopped: unknown) => toAppError(stopped, "transcription source stop failed"));
    if (session !== undefined) {
      await session.terminate().catch(() => undefined);
    }
    await consumeEvents.catch(() => undefined);
    const disposed = await input.source
      .dispose()
      .catch((released: unknown) =>
        err(toAppError(released, "transcription source release failed")),
      );
    const cleanupCodes: string[] = [];
    if (stopError !== undefined) {
      cleanupCodes.push(stopError.code);
    }
    if (disposed.isErr()) {
      cleanupCodes.push(disposed.error.code);
    }
    if (cleanupCodes.length === 0) {
      return err(primary);
    }
    const details: Record<string, string> = { ...(primary.details ?? {}) };
    details["cleanup"] = cleanupCodes.join(",");
    return err(
      appError(primary.code, primary.message, {
        ...(primary.correlationId === undefined ? {} : { correlationId: primary.correlationId }),
        details,
      }),
    );
  }
}
