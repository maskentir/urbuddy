import { createHash } from "node:crypto";

import { appError, toAppError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

import {
  streamEventSchema,
  type ReplaySummary,
  type SessionOutput,
  type StreamEvent,
} from "./events.js";

export interface ReplaySource {
  readonly events: AsyncIterable<unknown>;
  dispose(): Promise<void>;
}

export type ReplaySink = (event: SessionOutput) => void | Promise<void>;

export interface ReplayOptions {
  readonly signal?: AbortSignal;
  readonly maxUtterances?: number;
  readonly maxTextBytes?: number;
  readonly maxIdBytes?: number;
}

interface ReplayBounds {
  readonly maxUtterances: number;
  readonly maxTextBytes: number;
  readonly maxIdBytes: number;
}

const DEFAULT_MAX_UTTERANCES = 10_000;
const DEFAULT_MAX_TEXT_BYTES = 65_536;
const DEFAULT_MAX_ID_BYTES = 256;

interface TrackedUtterance {
  revision: number;
  contentHash: string;
  finalized: boolean;
}

interface ReplayCounts {
  applied: number;
  duplicates: number;
  stale: number;
  gaps: number;
  missing: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashEvent(event: StreamEvent): string {
  return hashText(JSON.stringify([event.utteranceId, event.revision, event.kind, event.text]));
}

function invalid(message: string): AppError {
  return appError("VALIDATION_FAILED", message);
}

function cancelled(): AppError {
  return appError("CANCELLED", "replay cancelled");
}

function withCleanupEvidence(primary: AppError, thrown: unknown): AppError {
  const cleanup = toAppError(thrown, "replay cleanup failed");
  return appError(primary.code, primary.message, {
    ...(primary.correlationId === undefined ? {} : { correlationId: primary.correlationId }),
    details: { ...primary.details, cleanup: cleanup.code },
  });
}

export class SessionRuntime {
  async run(
    source: ReplaySource,
    sink: ReplaySink,
    options: ReplayOptions = {},
  ): Promise<Result<ReplaySummary, AppError>> {
    const bounds: ReplayBounds = {
      maxUtterances: options.maxUtterances ?? DEFAULT_MAX_UTTERANCES,
      maxTextBytes: options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
      maxIdBytes: options.maxIdBytes ?? DEFAULT_MAX_ID_BYTES,
    };
    if (
      !Number.isSafeInteger(bounds.maxUtterances) ||
      bounds.maxUtterances < 1 ||
      !Number.isSafeInteger(bounds.maxTextBytes) ||
      bounds.maxTextBytes < 0 ||
      !Number.isSafeInteger(bounds.maxIdBytes) ||
      bounds.maxIdBytes < 1
    ) {
      await source.dispose().catch(() => undefined);
      return err(invalid("replay resource limits are invalid"));
    }
    let outcome: Result<ReplaySummary, AppError>;
    try {
      outcome = await this.processStream(source, sink, options.signal, bounds);
    } catch (thrown: unknown) {
      outcome = err(toAppError(thrown, "replay failed"));
    }
    try {
      await source.dispose();
    } catch (thrown: unknown) {
      if (outcome.isOk()) {
        return err(toAppError(thrown, "replay cleanup failed"));
      }
      return err(withCleanupEvidence(outcome.error, thrown));
    }
    if (outcome.isOk()) {
      if (options.signal !== undefined && options.signal.aborted) {
        return err(cancelled());
      }
      try {
        await sink({ type: "completed", summary: outcome.value });
      } catch (thrown: unknown) {
        return err(toAppError(thrown, "replay failed"));
      }
    }
    return outcome;
  }

  private async processStream(
    source: ReplaySource,
    sink: ReplaySink,
    signal: AbortSignal | undefined,
    bounds: ReplayBounds,
  ): Promise<Result<ReplaySummary, AppError>> {
    let iterator: AsyncIterator<unknown>;
    try {
      iterator = source.events[Symbol.asyncIterator]();
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "replay failed"));
    }
    let outcome: Result<ReplaySummary, AppError>;
    try {
      outcome = await this.consume(iterator, sink, signal, bounds);
    } catch (thrown: unknown) {
      outcome = err(toAppError(thrown, "replay failed"));
    }
    if (typeof iterator.return === "function") {
      try {
        await iterator.return();
      } catch (thrown: unknown) {
        if (outcome.isOk()) {
          return err(toAppError(thrown, "replay cleanup failed"));
        }
        return err(withCleanupEvidence(outcome.error, thrown));
      }
    }
    return outcome;
  }

  private async consume(
    iterator: AsyncIterator<unknown>,
    sink: ReplaySink,
    signal: AbortSignal | undefined,
    bounds: ReplayBounds,
  ): Promise<Result<ReplaySummary, AppError>> {
    if (signal !== undefined && signal.aborted) {
      return err(appError("CANCELLED", "replay cancelled before start"));
    }
    const admission = new SessionAdmission(bounds);
    for (;;) {
      if (signal !== undefined && signal.aborted) {
        return err(cancelled());
      }
      const next = await iterator.next();
      if (signal !== undefined && signal.aborted) {
        return err(cancelled());
      }
      if (next.done === true) {
        break;
      }
      const { gap, output } = admission.accept(next.value);
      if (gap !== undefined) {
        await sink(gap);
        if (signal?.aborted === true) return err(cancelled());
      }
      if (output.isErr()) return err(output.error);
      await sink(output.value);
    }
    if (signal?.aborted === true) return err(cancelled());
    const summary = admission.summary();
    return summary === undefined ? err(invalid("replay fixture contains no events")) : ok(summary);
  }
}

export class SessionAdmission {
  private identity: { sessionId: string; streamId: string } | undefined;
  private expectedSeq = 0;
  private lastSeq = -1;
  private lastSeqHash = "";
  private readonly utterances = new Map<string, TrackedUtterance>();
  private readonly counts: ReplayCounts = {
    applied: 0,
    duplicates: 0,
    stale: 0,
    gaps: 0,
    missing: 0,
  };

  constructor(
    private readonly bounds: ReplayBounds = {
      maxUtterances: DEFAULT_MAX_UTTERANCES,
      maxTextBytes: DEFAULT_MAX_TEXT_BYTES,
      maxIdBytes: DEFAULT_MAX_ID_BYTES,
    },
  ) {}

  accept(raw: unknown): {
    readonly gap?: Extract<SessionOutput, { type: "gap" }>;
    readonly output: Result<SessionOutput, AppError>;
  } {
    const parsed = streamEventSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        output: err(
          appError("VALIDATION_FAILED", "replay event failed validation", {
            details: {
              issues: parsed.error.issues.map((issue) => issue.message).join("; "),
            },
          }),
        ),
      };
    }
    const event = parsed.data;
    if (
      byteLength(event.sessionId) > this.bounds.maxIdBytes ||
      byteLength(event.streamId) > this.bounds.maxIdBytes ||
      byteLength(event.utteranceId) > this.bounds.maxIdBytes
    ) {
      return { output: err(invalid("replay event identifier exceeds the size bound")) };
    }
    if (byteLength(event.text) > this.bounds.maxTextBytes) {
      return { output: err(invalid("replay event text exceeds the size bound")) };
    }
    if (this.identity === undefined) {
      this.identity = { sessionId: event.sessionId, streamId: event.streamId };
    } else if (
      event.sessionId !== this.identity.sessionId ||
      event.streamId !== this.identity.streamId
    ) {
      return { output: err(invalid("replay event identity mismatch")) };
    }
    if (event.seq < this.expectedSeq) {
      if (event.seq === this.lastSeq) {
        if (hashEvent(event) !== this.lastSeqHash) {
          return { output: err(invalid("contradictory replay event")) };
        }
        this.counts.duplicates += 1;
        return {
          output: ok({
            type: "duplicate",
            seq: event.seq,
            utteranceId: event.utteranceId,
            revision: event.revision,
          }),
        };
      }
      this.counts.stale += 1;
      return {
        output: ok({
          type: "stale",
          seq: event.seq,
          utteranceId: event.utteranceId,
          revision: event.revision,
          reason: "superseded",
        }),
      };
    }

    const gap =
      event.seq > this.expectedSeq
        ? { type: "gap" as const, from: this.expectedSeq, to: event.seq }
        : undefined;
    if (gap !== undefined) {
      this.counts.gaps += 1;
      this.counts.missing += gap.to - gap.from;
    }
    this.lastSeq = event.seq;
    this.lastSeqHash = hashEvent(event);
    const output = this.applyEvent(event);
    this.expectedSeq = event.seq + 1;
    return gap === undefined ? { output } : { gap, output };
  }

  summary(): ReplaySummary | undefined {
    return this.identity === undefined ? undefined : { ...this.identity, ...this.counts };
  }

  private applyEvent(event: StreamEvent): Result<SessionOutput, AppError> {
    const contentHash = hashText(event.text);
    const stored = this.utterances.get(event.utteranceId);
    if (stored === undefined) {
      if (this.utterances.size >= this.bounds.maxUtterances) {
        return err(invalid("session utterance capacity exceeded"));
      }
      this.utterances.set(event.utteranceId, {
        revision: event.revision,
        contentHash,
        finalized: event.kind === "final",
      });
      this.counts.applied += 1;
      return ok({
        type: "applied",
        sessionId: event.sessionId,
        streamId: event.streamId,
        seq: event.seq,
        utteranceId: event.utteranceId,
        revision: event.revision,
        kind: event.kind,
        text: event.text,
      });
    }
    const identical =
      event.revision === stored.revision &&
      contentHash === stored.contentHash &&
      (event.kind === "final") === stored.finalized;
    if (identical) {
      this.counts.duplicates += 1;
      return ok({
        type: "duplicate",
        seq: event.seq,
        utteranceId: event.utteranceId,
        revision: event.revision,
      });
    }
    if (event.revision === stored.revision) {
      if (!stored.finalized && event.kind === "final" && contentHash === stored.contentHash) {
        this.utterances.set(event.utteranceId, {
          revision: event.revision,
          contentHash,
          finalized: true,
        });
        this.counts.applied += 1;
        return ok({
          type: "applied",
          sessionId: event.sessionId,
          streamId: event.streamId,
          seq: event.seq,
          utteranceId: event.utteranceId,
          revision: event.revision,
          kind: event.kind,
          text: event.text,
        });
      }
      return err(invalid("contradictory replay event"));
    }
    if (stored.finalized) {
      this.counts.stale += 1;
      return ok({
        type: "stale",
        seq: event.seq,
        utteranceId: event.utteranceId,
        revision: event.revision,
        reason: "finalized",
      });
    }
    if (event.revision < stored.revision) {
      this.counts.stale += 1;
      return ok({
        type: "stale",
        seq: event.seq,
        utteranceId: event.utteranceId,
        revision: event.revision,
        reason: "superseded",
      });
    }
    this.utterances.set(event.utteranceId, {
      revision: event.revision,
      contentHash,
      finalized: event.kind === "final",
    });
    this.counts.applied += 1;
    return ok({
      type: "applied",
      sessionId: event.sessionId,
      streamId: event.streamId,
      seq: event.seq,
      utteranceId: event.utteranceId,
      revision: event.revision,
      kind: event.kind,
      text: event.text,
    });
  }
}
